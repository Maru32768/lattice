//! What the phone reads (G47, design-review §32). The same documents come from the PC's server
//! (`lattice-server`) and from the snapshot in R2, so the page does not care which it reads.

use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::Mutex;

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::ingest;
use crate::msg;
use crate::store::{ArticleFilter, ArticleRow, ArticleSort, Store, StoredBlock, SummaryView, hex, sha256_hex};
use crate::translate;
use crate::url_norm::normalize;
use crate::vocab::{self, Capture};

/// The one credential of both paths. `secret.`, so it stays out of backups.
const TOKEN: &str = "secret.mobile_token";
/// Which library a QR code belongs to: article ids mean something else in another.
const LIBRARY_ID: &str = "mobile.library_id";
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
    /// The operations this list already reflects: the page stops showing them as its own.
    pub applied_ops: Vec<String>,
    /// The server turns operations away (`lattice-cli serve` without `--allow-write`): the page offers none.
    pub read_only: bool,
    /// The PC's own address. A page reading the snapshot goes there whenever it can reach it.
    pub live_url: Option<String>,
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
    // Before the articles: an operation applied in between then just stays on the phone for one more
    // list. The other way round, the list would claim one it does not show, and the phone would drop it.
    let applied_ops = applied_ops(store)?;
    Ok(MobileIndex {
        generated_at: unix_now(),
        ui_language: store.setting(translate::UI_LANGUAGE_SETTING).map_err(err)?,
        articles: store.list_articles_sorted(&ArticleFilter::All, ArticleSort::SavedDesc).map_err(err)?,
        applied_ops,
        read_only: false,
        live_url: live_url(store)?,
    })
}

pub fn article(store: &Store, id: i64) -> Result<Option<ArticleDoc>, String> {
    let view = translate::article_view(store, id)?;
    Ok(view.map(|v| ArticleDoc { article: v.article, target_language: v.target_language, blocks: v.blocks, summary: v.summary }))
}

/// Runs what would hold up the async workers: a store call may wait for its lock behind a job, and compressing takes time.
pub async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f).await.map_err(err)?
}

pub fn gzip(bytes: &[u8]) -> std::io::Result<Vec<u8>> {
    use std::io::Write;
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    enc.write_all(bytes)?;
    enc.finish()
}

// ---- operations -----------------------------------------------------------------------------

/// Something done on the phone, sent to the PC directly or left in the snapshot's inbox. The id is
/// the phone's own, so whichever way it arrives and however often, it applies once.
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export)]
pub struct MobileOp {
    pub id: String,
    pub op: OpKind,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, rename = "MobileOpKind")]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OpKind {
    VocabAdd { capture: Capture },
    SetRead { article_id: i64, read: bool },
    SetFavorite { article_id: i64, favorite: bool },
    SaveUrl { url: String },
}

/// What the app has to tell the rest of itself after an operation. Runners find their jobs by themselves
/// within 30 seconds (`IDLE_POLL`), so waking them only makes it sooner.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Effects {
    pub article: Option<i64>,
    pub vocab: bool,
    pub fetch: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Applied(Effects),
    /// Sent before: nothing happened this time.
    AlreadyApplied,
    /// It can never apply. The coded message says why; sending it again would not help.
    Rejected(String),
}

/// `id` becomes an object name in the inbox and a key here, and comes from the network.
pub fn valid_op_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// Stored ids older than this are forgotten: the phone gives up on an operation well before.
const KEEP_APPLIED_SECS: i64 = 90 * 24 * 60 * 60;
/// As many as the list carries. Far more than a phone has outstanding at once.
const APPLIED_IN_INDEX: i64 = 1000;
/// `MobileOp::VocabAdd`'s source address is shown as a link.
const MAX_SOURCE_URL: usize = 2048;

/// Two ways in (the server and the inbox) may hold the same operation at once.
static APPLYING: Mutex<()> = Mutex::new(());

/// Applies an operation unless it has been before. The operation is recorded after it applies, so a crash in
/// between applies it again, which changes nothing: each kind only sets a value or adds what is not there yet.
/// The record is for later: an operation sent again must not undo what the reader has changed on the PC since.
pub fn apply(store: &Store, op: &MobileOp) -> Result<Outcome, String> {
    if !valid_op_id(&op.id) {
        return Ok(Outcome::Rejected(msg!("mobile.badOp")));
    }
    let _one_at_a_time = APPLYING.lock().unwrap_or_else(|e| e.into_inner());
    let seen = store.conn().query_row("SELECT 1 FROM mobile_ops_applied WHERE id = ?1", [&op.id], |_| Ok(())).optional().map_err(err)?.is_some();
    if seen {
        return Ok(Outcome::AlreadyApplied);
    }
    let effects = match &op.op {
        OpKind::VocabAdd { capture } => {
            if let Err(message) = vocab::validate(&capture.surface, &capture.sentence) {
                return Ok(Outcome::Rejected(message));
            }
            vocab::capture(store, &stored_capture(store, capture)?)?;
            Effects { vocab: true, ..Effects::default() }
        }
        OpKind::SetRead { article_id, read } => {
            store.set_read_status(*article_id, *read).map_err(err)?;
            Effects { article: Some(*article_id), ..Effects::default() }
        }
        OpKind::SetFavorite { article_id, favorite } => {
            store.set_favorite(*article_id, *favorite).map_err(err)?;
            Effects { article: Some(*article_id), ..Effects::default() }
        }
        OpKind::SaveUrl { url } => {
            let saved = ingest::enqueue_urls(store, std::slice::from_ref(url))?;
            if saved.invalid > 0 {
                return Ok(Outcome::Rejected(msg!("mobile.badUrl")));
            }
            Effects { article: saved.ids.first().copied(), fetch: true, ..Effects::default() }
        }
    };
    let now = unix_now();
    let conn = store.conn();
    conn.execute("INSERT INTO mobile_ops_applied (id, applied_at) VALUES (?1, ?2)", params![op.id, now]).map_err(err)?;
    conn.execute("DELETE FROM mobile_ops_applied WHERE applied_at < ?1", [now - KEEP_APPLIED_SECS]).map_err(err)?;
    Ok(Outcome::Applied(effects))
}

/// The phone's word for where a capture came from, kept only as far as it still holds: the
/// article or its blocks may have gone since (re-extracted, deleted), and the address may be anything.
fn stored_capture(store: &Store, c: &Capture) -> Result<Capture, String> {
    let exists = |sql: &str, values: &[&dyn rusqlite::ToSql]| store.conn().query_row(sql, values, |_| Ok(())).optional().map(|r| r.is_some()).map_err(err);
    let article_id = match c.article_id {
        Some(id) if exists("SELECT 1 FROM articles WHERE id = ?1", &[&id])? => Some(id),
        _ => None,
    };
    let block_id = match (c.block_id, article_id) {
        (Some(block), Some(article)) if exists("SELECT 1 FROM blocks WHERE id = ?1 AND article_id = ?2", &[&block, &article])? => Some(block),
        _ => None,
    };
    let url = c.url.clone().filter(|u| u.len() <= MAX_SOURCE_URL && normalize(u).is_ok());
    Ok(Capture { surface: c.surface.clone(), sentence: c.sentence.clone(), article_id, block_id, url })
}

fn applied_ops(store: &Store) -> Result<Vec<String>, String> {
    let conn = store.conn();
    let mut stmt = conn.prepare("SELECT id FROM mobile_ops_applied ORDER BY applied_at DESC LIMIT ?1").map_err(err)?;
    let ids = stmt.query_map([APPLIED_IN_INDEX], |r| r.get(0)).map_err(err)?.collect::<rusqlite::Result<Vec<String>>>().map_err(err)?;
    Ok(ids)
}

// ---- settings -------------------------------------------------------------------------------

/// Where the PC's server listens. Neither serves TLS: `Local` is for a tunnel in front
/// (Tailscale Serve, cloudflared) that provides it, `Lan` is plain HTTP on the local network.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, rename = "MobileServerMode")]
#[serde(rename_all = "snake_case")]
pub enum ServerMode {
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

/// Well inside what a QR code holds together with the token.
pub const MAX_PUBLIC_URL: usize = 256;

/// The address as the phone uses it: `https://host` or `http://host:port`, without path or trailing slash.
pub(crate) fn clean_public_url(url: &str) -> Result<String, String> {
    let url = url.trim().trim_end_matches('/');
    if url.is_empty() {
        return Ok(String::new());
    }
    if url.len() > MAX_PUBLIC_URL {
        return Err(msg!("mobile.publicUrl"));
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
        // As text: the catalog would write a number as 1,024.
        return Err(msg!("mobile.port", min = MIN_PORT.to_string(), max = u16::MAX.to_string()));
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

/// Whether a request's token is the current one. Read each time, so regenerating it holds for every
/// server on this library at once, a `lattice-cli serve` too. Comparing hashes gives a timing attack nothing to measure.
pub fn token_accepted(store: &Store, presented: &str) -> Result<bool, String> {
    Ok(store.setting(TOKEN).map_err(err)?.is_some_and(|t| sha256_hex(&t) == sha256_hex(presented)))
}

/// What the Worker checks against: only the token's hash leaves this PC. The Worker's page may
/// connect to `live_origin`, the one other place it reads from.
pub(crate) fn auth_document(store: &Store) -> Result<Vec<u8>, String> {
    let live_origin = live_url(store)?.and_then(|u| url::Url::parse(&u).ok()).map(|u| u.origin().ascii_serialization());
    serde_json::to_vec(&serde_json::json!({ "token_hash": sha256_hex(token(store)?), "live_origin": live_origin })).map_err(err)
}

/// The address a tunnel gives the PC's server, while it serves. A bare network address is left out:
/// it would change with the network, and a page on HTTPS could not reach plain HTTP anyway.
fn live_url(store: &Store) -> Result<Option<String>, String> {
    let s = settings(store)?;
    Ok((s.mode != ServerMode::Off && !s.public_url.is_empty()).then_some(s.public_url))
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

/// What the phone opens, with the token and the library's id. `base` has no trailing slash.
pub fn phone_url(store: &Store, base: &str) -> Result<String, String> {
    let library = match store.setting(LIBRARY_ID).map_err(err)? {
        Some(id) => id,
        None => {
            let mut bytes = [0u8; 8];
            getrandom::fill(&mut bytes).map_err(err)?;
            let id = hex(&bytes);
            store.set_setting(LIBRARY_ID, Some(&id)).map_err(err)?;
            id
        }
    };
    Ok(format!("{base}/#t={}&l={library}", token(store)?))
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
        assert!(token_accepted(&s, &second).unwrap());
        assert!(!token_accepted(&s, &first).unwrap());
        assert!(TOKEN.starts_with(crate::store::SECRET_PREFIX));
    }

    #[test]
    fn no_token_is_accepted_before_one_exists() {
        assert!(!token_accepted(&store(), "").unwrap());
    }

    #[test]
    fn a_wildcard_address_is_never_offered_to_a_phone() {
        assert_eq!(base_of(Ipv4Addr::UNSPECIFIED.into(), 8787), None);
        assert_eq!(base_of(Ipv4Addr::new(192, 168, 0, 2).into(), 8787).as_deref(), Some("http://192.168.0.2:8787"));
    }

    #[test]
    fn a_library_keeps_its_id_through_a_new_token() {
        let s = store();
        let library = |url: &str| url.split("&l=").nth(1).unwrap().to_string();
        let first = phone_url(&s, "http://pc").unwrap();
        assert!(first.starts_with(&format!("http://pc/#t={}&l=", token(&s).unwrap())));
        regenerate_token(&s).unwrap();
        let second = phone_url(&s, "http://pc").unwrap();
        assert_ne!(first, second);
        assert_eq!(library(&first), library(&second));
        assert_ne!(library(&first), library(&phone_url(&store(), "http://pc").unwrap()));
    }

    #[test]
    fn an_address_too_long_for_a_qr_code_is_refused() {
        let s = store();
        let long = format!("https://{}.example", "x".repeat(MAX_PUBLIC_URL));
        assert!(save_settings(&s, &MobileSettings { mode: ServerMode::Lan, port: 8787, public_url: long }).is_err());
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

    fn op(id: &str, op: OpKind) -> MobileOp {
        MobileOp { id: id.into(), op }
    }

    fn saved_article(s: &Store) -> i64 {
        s.upsert_pending("https://example.com/a", "https://example.com/a", "example.com").unwrap().0
    }

    fn capture(article_id: Option<i64>, block_id: Option<i64>, url: Option<&str>) -> OpKind {
        OpKind::VocabAdd { capture: Capture { surface: "word".into(), sentence: "A word here.".into(), article_id, block_id, url: url.map(Into::into) } }
    }

    #[test]
    fn operations_set_what_they_say() {
        let s = store();
        let id = saved_article(&s);
        let row = || s.article_row(id).unwrap().unwrap();
        assert_eq!(
            apply(&s, &op("a", OpKind::SetRead { article_id: id, read: true })).unwrap(),
            Outcome::Applied(Effects { article: Some(id), ..Effects::default() })
        );
        assert_eq!(row().read_status, "read");
        apply(&s, &op("b", OpKind::SetFavorite { article_id: id, favorite: true })).unwrap();
        assert!(row().favorite);
        assert_eq!(apply(&s, &op("c", capture(Some(id), None, None))).unwrap(), Outcome::Applied(Effects { vocab: true, ..Effects::default() }));
        assert_eq!(vocab::list(&s).unwrap().len(), 1);
    }

    #[test]
    fn an_operation_sent_again_does_not_undo_what_changed_since() {
        let s = store();
        let id = saved_article(&s);
        let read = op("same-id", OpKind::SetRead { article_id: id, read: true });
        apply(&s, &read).unwrap();
        s.set_read_status(id, false).unwrap();
        assert_eq!(apply(&s, &read).unwrap(), Outcome::AlreadyApplied);
        assert_eq!(s.article_row(id).unwrap().unwrap().read_status, "unread");
    }

    #[test]
    fn the_index_says_which_operations_it_reflects() {
        let s = store();
        let id = saved_article(&s);
        assert!(index(&s).unwrap().applied_ops.is_empty());
        apply(&s, &op("sent-1", OpKind::SetRead { article_id: id, read: true })).unwrap();
        assert_eq!(index(&s).unwrap().applied_ops, ["sent-1"]);
    }

    #[test]
    fn saving_a_url_queues_a_fetch_once() {
        let s = store();
        let url = "https://example.com/new";
        let Outcome::Applied(first) = apply(&s, &op("a", OpKind::SaveUrl { url: url.into() })).unwrap() else {
            panic!("applied");
        };
        assert!(first.fetch && first.article.is_some());
        apply(&s, &op("b", OpKind::SaveUrl { url: url.into() })).unwrap();
        assert_eq!(s.list_articles_sorted(&ArticleFilter::All, ArticleSort::SavedDesc).unwrap().len(), 1);
    }

    #[test]
    fn what_can_never_apply_is_rejected_and_not_recorded() {
        let s = store();
        let rejected = |o: Outcome| matches!(o, Outcome::Rejected(_));
        assert!(rejected(apply(&s, &op("a", OpKind::SaveUrl { url: "javascript:alert(1)".into() })).unwrap()));
        let not_in_sentence = OpKind::VocabAdd { capture: Capture { surface: "word".into(), sentence: "Nothing of the kind.".into(), ..Capture::default() } };
        assert!(rejected(apply(&s, &op("b", not_in_sentence)).unwrap()));
        for id in ["", "../inbox", "a b", "a/b", &"x".repeat(65)] {
            assert!(rejected(apply(&s, &op(id, OpKind::SetRead { article_id: 1, read: true })).unwrap()), "{id}");
        }
        assert!(index(&s).unwrap().applied_ops.is_empty());
    }

    #[test]
    fn a_word_keeps_what_still_holds_of_its_source() {
        let s = store();
        let id = saved_article(&s);
        let source = |o: OpKind| {
            let OpKind::VocabAdd { capture } = o else {
                panic!("a capture")
            };
            let c = stored_capture(&s, &capture).unwrap();
            (c.article_id, c.block_id, c.url)
        };
        assert_eq!(
            source(capture(Some(id), Some(999), Some("https://example.com/a"))),
            (Some(id), None, Some("https://example.com/a".into())),
            "the block is gone"
        );
        assert_eq!(source(capture(Some(id + 1), Some(999), None)), (None, None, None), "the article is gone");
        assert_eq!(source(capture(None, None, Some("javascript:alert(1)"))), (None, None, None), "not an address to link to");
        apply(&s, &op("gone", capture(Some(id + 1), Some(999), None))).unwrap();
    }

    #[test]
    fn old_records_are_forgotten() {
        let s = store();
        s.conn().execute("INSERT INTO mobile_ops_applied (id, applied_at) VALUES ('old', 0)", []).unwrap();
        let id = saved_article(&s);
        apply(&s, &op("new", OpKind::SetRead { article_id: id, read: true })).unwrap();
        assert_eq!(index(&s).unwrap().applied_ops, ["new"]);
    }

    #[test]
    fn operations_read_as_the_page_writes_them() {
        let read: MobileOp = serde_json::from_str(r#"{"id":"a","op":{"kind":"set_read","article_id":1,"read":true}}"#).unwrap();
        assert!(matches!(read.op, OpKind::SetRead { article_id: 1, read: true }));
        let word: MobileOp = serde_json::from_str(r#"{"id":"a","op":{"kind":"vocab_add","capture":{"surface":"w","sentence":"w"}}}"#).unwrap();
        assert!(matches!(word.op, OpKind::VocabAdd { .. }));
        assert!(serde_json::from_str::<MobileOp>(r#"{"id":"a","op":{"kind":"delete_everything"}}"#).is_err());
    }

    #[test]
    fn the_page_learns_the_pcs_address_only_while_a_tunnel_serves_it() {
        let s = store();
        let live = |mode, public_url: &str| {
            save_settings(&s, &MobileSettings { mode, port: 8787, public_url: public_url.into() }).unwrap();
            (index(&s).unwrap().live_url, serde_json::from_slice::<serde_json::Value>(&auth_document(&s).unwrap()).unwrap()["live_origin"].clone())
        };
        assert_eq!(
            live(ServerMode::Local, "https://pc.example.ts.net"),
            (Some("https://pc.example.ts.net".into()), serde_json::json!("https://pc.example.ts.net"))
        );
        assert_eq!(live(ServerMode::Off, "https://pc.example.ts.net"), (None, serde_json::Value::Null));
        assert_eq!(live(ServerMode::Lan, ""), (None, serde_json::Value::Null));
    }

    #[test]
    fn only_the_tokens_hash_leaves_this_pc() {
        let s = store();
        let t = token(&s).unwrap();
        let auth = String::from_utf8(auth_document(&s).unwrap()).unwrap();
        assert!(!auth.contains(&t));
        assert!(auth.contains(&sha256_hex(&t)));
    }

    #[test]
    fn gzip_round_trips() {
        use std::io::Read;
        let mut out = String::new();
        flate2::read::GzDecoder::new(&gzip(b"hello").unwrap()[..]).read_to_string(&mut out).unwrap();
        assert_eq!(out, "hello");
    }
}
