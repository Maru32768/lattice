use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

pub use reqwest::Client as HttpClient;

/// Web pages are untrusted: cap the body so a hostile server can't exhaust memory.
pub const MAX_BODY: usize = 20 * 1024 * 1024;

pub struct Fetched {
    pub final_url: String,
    pub status: u16,
    pub content_type: Option<String>,
    pub html: String,
}

/// Pages and feeds get fetched without the user vetting each URL (feed entries, bulk imports,
/// redirects), so no fetch may reach this machine or the local network, typed URLs included.
// shortcut: with a system proxy the proxy resolves target names, so only IP literals are checked; resolve via the proxy's view if proxies matter.
pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(concat!("Lattice/", env!("CARGO_PKG_VERSION"), " (+local reader)"))
        .timeout(Duration::from_secs(30))
        .dns_resolver(PublicDns)
        .redirect(reqwest::redirect::Policy::custom(|a| {
            if a.previous().len() > 10 {
                a.error("too many redirects")
            } else if !public_host(a.url()) {
                a.error("redirect to a private address")
            } else {
                a.follow()
            }
        }))
        .build()
        .expect("static client config")
}

/// Names go through `PublicDns`; IP literals skip DNS and are checked here.
pub fn check_public(url: &str) -> Result<(), String> {
    let u = reqwest::Url::parse(url).map_err(|e| format!("invalid URL: {e}"))?;
    if public_host(&u) { Ok(()) } else { Err("refusing to fetch a private address".into()) }
}

fn public_host(u: &reqwest::Url) -> bool {
    match u.host() {
        Some(url::Host::Ipv4(ip)) => is_public(ip.into()),
        Some(url::Host::Ipv6(ip)) => is_public(ip.into()),
        Some(url::Host::Domain(_)) => true,
        None => false,
    }
}

fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_multicast()
                || a == 0
                || a >= 240
                || (a == 100 && (64..128).contains(&b)))
        }
        IpAddr::V6(v6) => match v6.to_ipv4() {
            Some(v4) => is_public(v4.into()),
            None => {
                let s0 = v6.segments()[0];
                !(v6.is_multicast() || s0 & 0xfe00 == 0xfc00 || s0 & 0xffc0 == 0xfe80)
            }
        },
    }
}

/// reqwest's own message hides the cause (e.g. a refused private address); append the innermost source.
pub(crate) fn request_error(e: reqwest::Error) -> String {
    let mut cause: &dyn std::error::Error = &e;
    while let Some(next) = cause.source() {
        cause = next;
    }
    format!("request failed: {e}: {cause}")
}

struct PublicDns;

impl reqwest::dns::Resolve for PublicDns {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0)).await?.filter(|a| is_public(a.ip())).collect();
            if addrs.is_empty() {
                return Err(format!("{host} has no public address").into());
            }
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// What a URL answered: a web page, or a PDF's bytes.
pub enum Resource {
    Page(Fetched),
    Pdf { final_url: String, bytes: Vec<u8> },
}

pub async fn fetch(client: &reqwest::Client, url: &str) -> Result<Fetched, String> {
    match fetch_resource(client, url).await? {
        Resource::Page(page) => Ok(page),
        Resource::Pdf { .. } => Err(format!("unsupported content type: {}", crate::pdf::CONTENT_TYPE)),
    }
}

/// A page, or a PDF (a paper's `…/pdf/…` link).
pub async fn fetch_resource(client: &reqwest::Client, url: &str) -> Result<Resource, String> {
    check_public(url)?;
    let mut resp = client.get(url).send().await.map_err(request_error)?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    let content_type = resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).map(str::to_string);
    let cap = body_cap(content_type.as_deref())?;
    let final_url = resp.url().to_string();
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("read failed: {e}"))? {
        body.extend_from_slice(&chunk);
        if body.len() > cap {
            return Err(format!("body exceeds {cap} bytes"));
        }
    }
    resource(final_url, status.as_u16(), content_type, body)
}

/// Which responses are read, and up to how many bytes: pages, and what may be a PDF.
fn body_cap(content_type: Option<&str>) -> Result<usize, String> {
    match content_type.map(str::to_ascii_lowercase) {
        Some(ct) if ct.contains("pdf") || ct.contains("octet-stream") => Ok(crate::pdf::MAX_BYTES),
        Some(ct) if !ct.contains("html") => Err(format!("unsupported content type: {ct}")),
        _ => Ok(MAX_BODY),
    }
}

fn resource(final_url: String, status: u16, content_type: Option<String>, body: Vec<u8>) -> Result<Resource, String> {
    if crate::pdf::is_pdf(content_type.as_deref(), &body) {
        return Ok(Resource::Pdf { final_url, bytes: body });
    }
    if let Some(ct) = content_type.as_deref().filter(|ct| ct.contains("octet-stream")) {
        return Err(format!("unsupported content type: {ct}"));
    }
    let html = decode_html(content_type.as_deref(), &body);
    Ok(Resource::Page(Fetched { final_url, status, content_type, html }))
}

/// Charset precedence follows browsers: BOM (handled by `decode`), Content-Type, then
/// `<meta charset>` / `http-equiv` within the first 1024 bytes, else UTF-8.
fn decode_html(content_type: Option<&str>, body: &[u8]) -> String {
    let head = String::from_utf8_lossy(&body[..body.len().min(1024)]).to_ascii_lowercase();
    let encoding = content_type
        .map(str::to_ascii_lowercase)
        .and_then(|ct| charset_label(&ct))
        .or_else(|| charset_label(&head))
        .and_then(|l| encoding_rs::Encoding::for_label(l.as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);
    encoding.decode(body).0.into_owned()
}

fn charset_label(s: &str) -> Option<String> {
    let rest = &s[s.find("charset=")? + "charset=".len()..];
    let rest = rest.trim_start_matches(['"', '\'', ' ']);
    let label: String = rest.chars().take_while(|c| !matches!(c, '"' | '\'' | ';' | ' ' | '>' | '/')).collect();
    (!label.is_empty()).then_some(label)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_addresses() {
        let ip = |s: &str| is_public(s.parse().unwrap());
        for private in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "0.0.0.0",
            "100.64.0.1",
            "255.255.255.255",
            "::1",
            "::",
            "fc00::1",
            "fd12::1",
            "fe80::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
        ] {
            assert!(!ip(private), "{private}");
        }
        for public in ["93.184.215.14", "1.1.1.1", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"] {
            assert!(ip(public), "{public}");
        }
        assert!(check_public("http://[::1]:8080/").is_err());
        assert!(check_public("http://169.254.169.254/latest/meta-data").is_err());
        assert!(check_public("https://example.com/").is_ok());
    }

    #[tokio::test]
    async fn refuses_private_targets() {
        let c = client();
        for url in ["http://127.0.0.1:9/", "http://localhost:9/"] {
            let e = fetch(&c, url).await.err().unwrap();
            assert!(e.contains("private") || e.contains("public address"), "{url}: {e}");
        }
    }

    #[test]
    fn tells_pdfs_from_pages() {
        let res = |ct: Option<&str>, body: &[u8]| resource("https://arxiv.org/pdf/1".into(), 200, ct.map(String::from), body.to_vec());
        assert!(matches!(res(Some("application/pdf"), b"%PDF-1.5"), Ok(Resource::Pdf { .. })));
        assert!(matches!(res(Some("application/octet-stream"), b"%PDF-1.5"), Ok(Resource::Pdf { .. })), "sniffed");
        assert!(matches!(res(None, b"%PDF-1.5"), Ok(Resource::Pdf { .. })));
        assert!(res(Some("application/octet-stream"), b"\x00\x01").is_err());
        assert!(matches!(res(Some("text/html"), b"<p>x</p>"), Ok(Resource::Page(p)) if p.html == "<p>x</p>"));
        assert_eq!(body_cap(Some("Application/PDF")), Ok(crate::pdf::MAX_BYTES));
        assert_eq!(body_cap(Some("text/html; charset=utf-8")), Ok(MAX_BODY));
        assert!(body_cap(Some("image/png")).is_err());
    }

    #[test]
    fn detects_charset() {
        let sjis = b"<html><head><meta charset=\"Shift_JIS\"></head><body>\x93\xfa\x96\x7b\x8c\xea</body></html>";
        assert!(decode_html(None, sjis).contains("日本語"));
        let equiv = b"<meta http-equiv=\"Content-Type\" content=\"text/html; charset=EUC-JP\">\xc6\xfc\xcb\xdc";
        assert!(decode_html(Some("text/html"), equiv).contains("日本"));
        // Header wins over meta; unknown labels fall back to UTF-8.
        assert!(decode_html(Some("text/html; charset=utf-8"), "<meta charset=shift_jis>日本".as_bytes()).contains("日本"));
        assert!(decode_html(Some("text/html; charset=bogus"), "é".as_bytes()).contains('é'));
    }
}
