//! What the phone reads (G47, design-review §32). The same documents come from the PC's server
//! (`lattice-server`) and from the snapshot in R2, so the page does not care which it reads.

use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::msg;
use crate::store::{ArticleFilter, ArticleRow, ArticleSort, Store, StoredBlock, SummaryView, hex, sha256_hex};
use crate::translate;

/// The one credential of both paths. `secret.`, so it stays out of backups.
const TOKEN: &str = "secret.mobile_token";
const MODE: &str = "mobile.mode";
const PORT: &str = "mobile.port";
const PUBLIC_URL: &str = "mobile.public_url";
pub const DEFAULT_PORT: u16 = 8787;

fn err(e: impl ToString) -> String {
    e.to_string()
}

fn unix_now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or_default()
}

// ---- documents ------------------------------------------------------------------------------

#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct MobileIndex {
    /// When this list was made, in Unix seconds: how old a snapshot is.
    pub generated_at: i64,
    /// The PC's display language; the page follows it.
    pub ui_language: Option<String>,
    pub articles: Vec<ArticleRow>,
}

/// An article for reading: `ArticleView` without the job list and the memo, which the page does not show.
#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct ArticleDoc {
    pub article: ArticleRow,
    #[ts(type = "\"ja\" | \"en\"")]
    pub target_language: &'static str,
    pub blocks: Vec<StoredBlock>,
    pub summary: Option<SummaryView>,
}

pub fn index(store: &Store) -> Result<MobileIndex, String> {
    Ok(MobileIndex {
        generated_at: unix_now(),
        ui_language: store.setting(translate::UI_LANGUAGE_SETTING).map_err(err)?,
        articles: store.list_articles_sorted(&ArticleFilter::All, ArticleSort::SavedDesc).map_err(err)?,
    })
}

pub fn article(store: &Store, id: i64) -> Result<Option<ArticleDoc>, String> {
    let view = translate::article_view(store, id)?;
    Ok(view.map(|v| ArticleDoc { article: v.article, target_language: v.target_language, blocks: v.blocks, summary: v.summary }))
}

pub fn gzip(bytes: &[u8]) -> std::io::Result<Vec<u8>> {
    use std::io::Write;
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    enc.write_all(bytes)?;
    enc.finish()
}

// ---- settings -------------------------------------------------------------------------------

/// Where the PC's server listens. Neither serves TLS: `Local` is for a tunnel in front
/// (Tailscale Serve, cloudflared) that provides it, `Lan` is plain HTTP on the local network.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, rename = "MobileServerMode")]
#[serde(rename_all = "snake_case")]
pub enum ServerMode {
    #[default]
    Off,
    Local,
    Lan,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MobileSettings {
    pub mode: ServerMode,
    pub port: u16,
    /// The address the phone opens, when a tunnel gives it one. Empty: this PC's own address.
    pub public_url: String,
}

pub fn settings(store: &Store) -> Result<MobileSettings, String> {
    let mode = match store.setting(MODE).map_err(err)?.as_deref() {
        Some("local") => ServerMode::Local,
        Some("lan") => ServerMode::Lan,
        _ => ServerMode::Off,
    };
    let port = store.setting(PORT).map_err(err)?.and_then(|p| p.parse().ok()).unwrap_or(DEFAULT_PORT);
    Ok(MobileSettings { mode, port, public_url: store.setting(PUBLIC_URL).map_err(err)?.unwrap_or_default() })
}

/// The address as the phone uses it: `https://host` or `http://host:port`, without path or trailing slash.
fn clean_public_url(url: &str) -> Result<String, String> {
    let url = url.trim().trim_end_matches('/');
    if url.is_empty() {
        return Ok(String::new());
    }
    let parsed = url::Url::parse(url).map_err(|_| msg!("mobile.publicUrl"))?;
    let plain = parsed.path() == "/" && parsed.query().is_none() && parsed.fragment().is_none() && parsed.username().is_empty() && parsed.password().is_none();
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() || !plain {
        return Err(msg!("mobile.publicUrl"));
    }
    Ok(url.to_string())
}

pub fn save_settings(store: &Store, s: &MobileSettings) -> Result<(), String> {
    if s.port < MIN_PORT {
        return Err(msg!("mobile.port", min = MIN_PORT));
    }
    let public_url = clean_public_url(&s.public_url)?;
    let mode = match s.mode {
        ServerMode::Off => "off",
        ServerMode::Local => "local",
        ServerMode::Lan => "lan",
    };
    store.set_setting(MODE, Some(mode)).map_err(err)?;
    store.set_setting(PORT, Some(&s.port.to_string())).map_err(err)?;
    store.set_setting(PUBLIC_URL, Some(public_url.as_str()).filter(|u| !u.is_empty())).map_err(err)
}

/// Below this, Windows lets anyone bind but other software expects the ports for itself.
const MIN_PORT: u16 = 1024;

// ---- token ----------------------------------------------------------------------------------

/// The token, made on first use.
pub fn token(store: &Store) -> Result<String, String> {
    match store.setting(TOKEN).map_err(err)? {
        Some(t) => Ok(t),
        None => regenerate_token(store),
    }
}

/// A new token: whoever holds the old one can no longer read or send anything.
pub fn regenerate_token(store: &Store) -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(err)?;
    let token = hex(&bytes);
    store.set_setting(TOKEN, Some(&token)).map_err(err)?;
    Ok(token)
}

/// What servers keep and compare instead of the token: comparing hashes gives a timing attack nothing to measure.
pub fn token_hash(token: &str) -> String {
    sha256_hex(token)
}

// ---- addresses ------------------------------------------------------------------------------

/// The address other devices reach this PC at: the one the route to the Internet leaves from.
/// Connecting a UDP socket sends nothing.
// shortcut: on a full-tunnel VPN this is the VPN's address, and without a default route there is none. The address
// the phone opens can be typed in the settings. Enumerating the interfaces, which needs a dependency, would remove this.
pub fn lan_ip() -> Option<IpAddr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((Ipv4Addr::new(8, 8, 8, 8), 53)).ok()?;
    socket.local_addr().ok().map(|a| a.ip())
}

/// What the phone opens, token included. `base` has no trailing slash.
pub fn phone_url(base: &str, token: &str) -> String {
    format!("{base}/#t={token}")
}

/// `http://<ip>:<port>`, or nothing when `ip` is no address a phone can connect to.
pub fn base_of(ip: IpAddr, port: u16) -> Option<String> {
    (!ip.is_unspecified()).then(|| format!("http://{}", SocketAddr::new(ip, port)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        Store::open_in_memory().unwrap()
    }

    #[test]
    fn settings_default_to_off_and_keep_what_was_saved() {
        let s = store();
        assert_eq!(settings(&s).unwrap().mode, ServerMode::Off);
        assert_eq!(settings(&s).unwrap().port, DEFAULT_PORT);
        save_settings(&s, &MobileSettings { mode: ServerMode::Lan, port: 9000, public_url: " https://pc.example.ts.net/ ".into() }).unwrap();
        let got = settings(&s).unwrap();
        assert_eq!((got.mode, got.port, got.public_url.as_str()), (ServerMode::Lan, 9000, "https://pc.example.ts.net"));
        save_settings(&s, &MobileSettings { mode: ServerMode::Off, port: 9000, public_url: String::new() }).unwrap();
        assert_eq!(settings(&s).unwrap().public_url, "");
    }

    #[test]
    fn a_bad_port_or_address_is_refused() {
        let s = store();
        let refused = |port, url: &str| save_settings(&s, &MobileSettings { mode: ServerMode::Lan, port, public_url: url.into() }).is_err();
        assert!(refused(80, ""));
        for url in ["ftp://pc", "pc.example", "https://pc/path", "https://user:pw@pc", "https://pc?x=1", "https://pc#t=1", "javascript:alert(1)"] {
            assert!(refused(8787, url), "{url}");
        }
        assert!(!refused(8787, "http://192.168.0.2:8787"));
    }

    #[test]
    fn the_token_stays_until_regenerated_and_is_never_backed_up() {
        let s = store();
        let first = token(&s).unwrap();
        assert_eq!(first.len(), 64);
        assert_eq!(token(&s).unwrap(), first);
        let second = regenerate_token(&s).unwrap();
        assert_ne!(second, first);
        assert_eq!(token(&s).unwrap(), second);
        assert_ne!(token_hash(&first), token_hash(&second));
        assert!(TOKEN.starts_with(crate::store::SECRET_PREFIX));
    }

    #[test]
    fn a_wildcard_address_is_never_offered_to_a_phone() {
        assert_eq!(base_of(Ipv4Addr::UNSPECIFIED.into(), 8787), None);
        assert_eq!(base_of(Ipv4Addr::new(192, 168, 0, 2).into(), 8787).as_deref(), Some("http://192.168.0.2:8787"));
        assert_eq!(phone_url("http://192.168.0.2:8787", "abc"), "http://192.168.0.2:8787/#t=abc");
    }

    #[test]
    fn documents_read_what_the_reader_reads() {
        let s = store();
        let (id, _) = s.upsert_pending("https://example.com/a", "https://example.com/a", "example.com").unwrap();
        let index = index(&s).unwrap();
        assert_eq!(index.articles.iter().map(|a| a.id).collect::<Vec<_>>(), [id]);
        assert!(index.generated_at > 0);
        let doc = article(&s, id).unwrap().unwrap();
        assert_eq!(doc.article.original_url, "https://example.com/a");
        assert!(article(&s, id + 1).unwrap().is_none());
        let json = serde_json::to_value(&doc).unwrap();
        assert!(json.get("jobs").is_none() && json.get("note").is_none());
    }

    #[test]
    fn gzip_round_trips() {
        use std::io::Read;
        let mut out = String::new();
        flate2::read::GzDecoder::new(&gzip(b"hello").unwrap()[..]).read_to_string(&mut out).unwrap();
        assert_eq!(out, "hello");
    }
}
