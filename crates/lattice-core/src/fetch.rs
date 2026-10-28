use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use hyper_util::client::proxy::matcher::Matcher;
use reqwest::header::{HeaderMap, LOCATION};

use crate::network::{NetworkSettings, Policy};
use crate::store::Store;

#[derive(Clone)]
pub struct HttpClient {
    transport: Arc<RwLock<Arc<Transport>>>,
}

struct Transport {
    policy: Arc<Policy>,
    direct: reqwest::Client,
    proxies: Matcher,
    proxy_clients: Mutex<HashMap<String, reqwest::Client>>,
}

pub(crate) enum GetError {
    Policy(String),
    Request(reqwest::Error),
}

impl GetError {
    pub(crate) fn is_timeout(&self) -> bool {
        matches!(self, Self::Request(e) if e.is_timeout())
    }

    pub(crate) fn message(self) -> String {
        match self {
            Self::Policy(message) => message,
            Self::Request(error) => request_error(error),
        }
    }
}

/// Web pages are untrusted: cap the body so a hostile server can't exhaust memory.
pub const MAX_BODY: usize = 20 * 1024 * 1024;

pub struct Fetched {
    pub final_url: String,
    pub status: u16,
    pub content_type: Option<String>,
    pub html: String,
}

fn builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .user_agent(concat!("Lattice/", env!("CARGO_PKG_VERSION"), " (+local reader)"))
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
}

impl Transport {
    fn new(settings: &NetworkSettings, proxies: Matcher) -> Result<Self, String> {
        let policy = Arc::new(Policy::parse(settings)?);
        let direct = builder().dns_resolver(PolicyDns(policy.clone())).build().map_err(request_error)?;
        Ok(Self { policy, direct, proxies, proxy_clients: Mutex::new(HashMap::new()) })
    }

    fn route(&self, url: &reqwest::Url) -> Result<reqwest::Client, String> {
        let authority = &url[url::Position::BeforeHost..url::Position::AfterPort];
        let uri = http::Uri::builder().scheme(url.scheme()).authority(authority).path_and_query("/").build().map_err(|e| e.to_string())?;
        let Some(proxy) = self.proxies.intercept(&uri) else {
            return Ok(self.direct.clone());
        };
        let mut clients = self.proxy_clients.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(client) = clients.get(url.scheme()) {
            return Ok(client.clone());
        }
        let mut config = reqwest::Proxy::all(proxy.uri().to_string()).map_err(request_error)?;
        if let Some(auth) = proxy.basic_auth() {
            config = config.custom_http_auth(auth.clone());
        }
        let client = builder().proxy(config).build().map_err(request_error)?;
        clients.insert(url.scheme().to_string(), client.clone());
        Ok(client)
    }
}

impl HttpClient {
    pub fn configured(settings: &NetworkSettings) -> Result<Self, String> {
        Self::with_proxies(settings, Matcher::from_system())
    }

    fn with_proxies(settings: &NetworkSettings, proxies: Matcher) -> Result<Self, String> {
        let transport = Transport::new(settings, proxies)?;
        Ok(Self { transport: Arc::new(RwLock::new(Arc::new(transport))) })
    }

    /// New requests, including those from existing clones, use fresh connection pools.
    /// Already started requests finish with the policy snapshot they captured.
    pub fn set_settings(&self, store: &Store, settings: &NetworkSettings) -> Result<(), String> {
        let next = Arc::new(Transport::new(settings, Matcher::from_system())?);
        crate::network::save(store, settings)?;
        *self.transport.write().unwrap_or_else(|e| e.into_inner()) = next;
        Ok(())
    }

    pub(crate) async fn get(&self, url: &str, mut headers: HeaderMap) -> Result<reqwest::Response, GetError> {
        let transport = self.transport.read().unwrap_or_else(|e| e.into_inner()).clone();
        let mut url = reqwest::Url::parse(url).map_err(|e| GetError::Policy(e.to_string()))?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        for hop in 0..=10 {
            transport.policy.check_url(&url).map_err(GetError::Policy)?;
            let client = transport.route(&url).map_err(GetError::Policy)?;
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(GetError::Policy(crate::msg!("network.redirectTimeout")));
            }
            let response = client.get(url.clone()).headers(headers.clone()).timeout(remaining).send().await.map_err(GetError::Request)?;
            if !matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
                return Ok(response);
            }
            let Some(location) = response.headers().get(LOCATION) else {
                return Ok(response);
            };
            if hop == 10 {
                return Err(GetError::Policy(crate::msg!("network.tooManyRedirects")));
            }
            let next = url.join(location.to_str().map_err(|e| GetError::Policy(e.to_string()))?).map_err(|e| GetError::Policy(e.to_string()))?;
            if next.origin() != url.origin() {
                for header in ["authorization", "cookie", "proxy-authorization", "referer", "if-none-match", "if-modified-since"] {
                    headers.remove(header);
                }
            }
            url = next;
        }
        unreachable!("redirect loop returns on its final hop")
    }
}

pub fn client() -> HttpClient {
    HttpClient::configured(&NetworkSettings::default()).expect("static client config")
}

/// The native renderer retains its separate default URL check, without configurable exceptions.
pub fn check_public(url: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(url).map_err(|e| format!("invalid URL: {e}"))?;
    Policy::parse(&NetworkSettings::default())?.check_url(&url)
}

/// reqwest's own message hides the cause (e.g. a refused private address); append the innermost source.
/// Common network failures become a plain message, with that raw text kept as `detail`.
pub(crate) fn request_error(e: reqwest::Error) -> String {
    let chain = || std::iter::successors(Some(&e as &(dyn std::error::Error + 'static)), |c| c.source());
    let cause = chain().last().expect("the error itself");
    let detail = format!("request failed: {e}: {cause}");
    let io_kind = |c: &(dyn std::error::Error + 'static)| c.downcast_ref::<std::io::Error>().map(std::io::Error::kind);
    let kinds: Vec<_> = chain().filter_map(io_kind).collect();
    if chain().any(|c| c.is::<native_tls::Error>()) {
        crate::msg!("fetch.tls", detail = detail)
    } else if chain().any(|c| c.to_string() == "dns error") && cause.is::<std::io::Error>() {
        crate::msg!("fetch.dns", detail = detail)
    } else if kinds.contains(&std::io::ErrorKind::ConnectionRefused) {
        crate::msg!("fetch.refused", detail = detail)
    } else if e.is_timeout() || kinds.contains(&std::io::ErrorKind::TimedOut) {
        crate::msg!("fetch.timeout", detail = detail)
    } else {
        detail
    }
}

struct PolicyDns(Arc<Policy>);

impl reqwest::dns::Resolve for PolicyDns {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        let policy = self.0.clone();
        Box::pin(async move {
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0)).await?.filter(|a| policy.allows_ip(&host, a.ip())).collect();
            if addrs.is_empty() {
                return Err(crate::msg!("network.blocked", host = host).into());
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

pub async fn fetch(client: &HttpClient, url: &str) -> Result<Fetched, String> {
    match fetch_resource(client, url).await? {
        Resource::Page(page) => Ok(page),
        Resource::Pdf { .. } => Err(format!("unsupported content type: {}", crate::pdf::CONTENT_TYPE)),
    }
}

/// A page, or a PDF (a paper's `…/pdf/…` link).
pub async fn fetch_resource(client: &HttpClient, url: &str) -> Result<Resource, String> {
    let mut resp = client.get(url, HeaderMap::new()).await.map_err(GetError::message)?;
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
    use crate::network::{Mode, is_public};

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
        let c = HttpClient::with_proxies(&NetworkSettings::default(), Matcher::builder().build()).unwrap();
        for url in ["http://127.0.0.1:9/", "http://localhost:9/"] {
            let e = fetch(&c, url).await.err().unwrap();
            assert!(e.contains("network.blocked"), "{url}: {e}");
        }
    }

    struct Server {
        addr: SocketAddr,
        seen: tokio::sync::mpsc::UnboundedReceiver<String>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn server(response: String) -> Server {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, seen) = tokio::sync::mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let mut request = Vec::new();
                let mut buf = [0; 1024];
                while !request.ends_with(b"\r\n\r\n") && request.len() < 64 * 1024 {
                    let size = stream.read(&mut buf).await.unwrap();
                    if size == 0 {
                        break;
                    }
                    request.extend_from_slice(&buf[..size]);
                }
                let _ = tx.send(String::from_utf8_lossy(&request).to_string());
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });
        Server { addr, seen, task }
    }

    fn response() -> String {
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".into()
    }

    #[tokio::test]
    async fn local_exceptions_and_cloned_clients_follow_saved_changes() {
        let mut local = server(response()).await;
        let settings = NetworkSettings { mode: Mode::Public, allow: vec!["localhost".into()], deny: vec![] };
        let c = HttpClient::with_proxies(&settings, Matcher::builder().build()).unwrap();
        let cloned = c.clone();
        let url = format!("http://localhost:{}/", local.addr.port());
        assert_eq!(fetch(&cloned, &url).await.unwrap().html, "ok");
        assert!(local.seen.recv().await.unwrap().starts_with("GET /"));
        let store = Store::open_in_memory().unwrap();
        let invalid = NetworkSettings { allow: vec!["https://bad.example".into()], ..settings };
        assert!(c.set_settings(&store, &invalid).is_err());
        assert_eq!(fetch(&cloned, &url).await.unwrap().html, "ok", "invalid edits preserve active settings");
        local.seen.recv().await.unwrap();
        c.set_settings(&store, &NetworkSettings::default()).unwrap();
        assert_eq!(crate::network::settings(&store).unwrap(), NetworkSettings::default());
        assert!(fetch(&cloned, &url).await.err().unwrap().contains("network.blocked"));
        assert!(local.seen.try_recv().is_err(), "a previously cloned client cannot retain an allowed connection pool");
    }

    #[tokio::test]
    async fn proxy_hostname_auth_and_remote_dns_work_but_direct_dns_stays_guarded() {
        let mut proxy = server(response()).await;
        let matcher = Matcher::builder().all(format!("http://user:pass@localhost:{}", proxy.addr.port())).no("localhost").build();
        let c = HttpClient::with_proxies(&NetworkSettings::default(), matcher).unwrap();
        assert_eq!(fetch(&c, "http://does-not-resolve.invalid/article").await.unwrap().html, "ok");
        let request = proxy.seen.recv().await.unwrap();
        assert!(request.starts_with("GET http://does-not-resolve.invalid/article HTTP/1.1"), "{request}");
        assert!(request.to_lowercase().contains("proxy-authorization: basic dxnlcjpwyxnz"), "{request}");
        assert!(fetch(&c, "http://localhost:9/").await.err().unwrap().contains("network.blocked"));
        assert!(proxy.seen.try_recv().is_err(), "NO_PROXY traffic never uses the proxy client");

        let mut tunnel = server("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into()).await;
        let matcher = Matcher::builder().https(format!("http://user:pass@localhost:{}", tunnel.addr.port())).build();
        let c = HttpClient::with_proxies(&NetworkSettings::default(), matcher).unwrap();
        assert!(fetch(&c, "https://does-not-resolve.invalid/article").await.is_err());
        let request = tunnel.seen.recv().await.unwrap();
        assert!(request.starts_with("CONNECT does-not-resolve.invalid:443 HTTP/1.1"), "{request}");
        assert!(request.to_lowercase().contains("proxy-authorization: basic dxnlcjpwyxnz"), "{request}");
    }

    #[tokio::test]
    async fn redirects_recheck_rules_and_proxy_bypass_routes() {
        let mut target = server(response()).await;
        let mut proxy =
            server(format!("HTTP/1.1 302 Found\r\nLocation: http://localhost:{}/secret\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", target.addr.port()))
                .await;
        let matcher = Matcher::builder().all(format!("http://localhost:{}", proxy.addr.port())).no("localhost").build();
        let c = HttpClient::with_proxies(&NetworkSettings::default(), matcher).unwrap();
        assert!(fetch(&c, "http://remote.invalid/start").await.err().unwrap().contains("network.blocked"));
        proxy.seen.recv().await.unwrap();
        assert!(target.seen.try_recv().is_err(), "proxy to direct redirect must not reach the local server");

        let allowed = NetworkSettings { mode: Mode::Allowlist, allow: vec!["remote.invalid".into(), "localhost".into()], deny: vec![] };
        let matcher = Matcher::builder().all(format!("http://localhost:{}", proxy.addr.port())).no("localhost").build();
        let c = HttpClient::with_proxies(&allowed, matcher).unwrap();
        let mut headers = HeaderMap::new();
        for name in ["authorization", "cookie", "referer", "if-none-match"] {
            headers.insert(reqwest::header::HeaderName::from_static(name), "secret".parse().unwrap());
        }
        let result = c.get("http://remote.invalid/start", headers).await.ok().unwrap();
        assert_eq!(result.status(), 200);
        let request = target.seen.recv().await.unwrap();
        assert!(!request.contains("secret\r\n"), "sensitive headers must not cross origins: {request}");

        let denied = NetworkSettings { deny: vec!["localhost".into()], ..allowed };
        let matcher = Matcher::builder().all(format!("http://localhost:{}", proxy.addr.port())).build();
        let c = HttpClient::with_proxies(&denied, matcher).unwrap();
        assert!(fetch(&c, "http://remote.invalid/start").await.err().unwrap().contains("network.blocked"));
        assert!(target.seen.try_recv().is_err());
    }

    #[tokio::test]
    async fn redirect_loops_stop_at_the_limit() {
        let mut local = server("HTTP/1.1 302 Found\r\nLocation: /again\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into()).await;
        let settings = NetworkSettings { mode: Mode::Unrestricted, ..NetworkSettings::default() };
        let c = HttpClient::with_proxies(&settings, Matcher::builder().build()).unwrap();
        assert!(fetch(&c, &format!("http://{}/", local.addr)).await.err().unwrap().contains("network.tooManyRedirects"));
        let mut count = 0;
        while local.seen.try_recv().is_ok() {
            count += 1;
        }
        assert_eq!(count, 11);
    }

    #[tokio::test]
    async fn names_common_network_failures() {
        use tokio::io::AsyncWriteExt;
        struct NoSuchHost;
        impl reqwest::dns::Resolve for NoSuchHost {
            fn resolve(&self, _: reqwest::dns::Name) -> reqwest::dns::Resolving {
                Box::pin(async { Err(std::io::Error::other("No such host is known.").into()) })
            }
        }
        let code = |e: &str| serde_json::from_str::<serde_json::Value>(e).map(|v| v["code"].as_str().unwrap_or_default().to_string()).unwrap_or_default();
        let get = |c: reqwest::Client, url: String| async move { request_error(c.get(url).send().await.unwrap_err()) };
        let with = |ms: u64| reqwest::Client::builder().timeout(Duration::from_millis(ms));

        let e = get(with(10_000).dns_resolver(NoSuchHost).build().unwrap(), "http://nowhere.example/".into()).await;
        assert_eq!(code(&e), "fetch.dns", "{e}");
        assert!(e.contains("No such host is known."), "the raw detail is kept: {e}");

        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
        let e = get(with(10_000).build().unwrap(), format!("http://{closed}/")).await;
        assert_eq!(code(&e), "fetch.refused", "{e}");

        let silent = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = silent.local_addr().unwrap();
        let e = get(with(300).build().unwrap(), format!("http://{addr}/")).await;
        assert_eq!(code(&e), "fetch.timeout", "{e}");

        // Plain HTTP where TLS is expected: the handshake fails.
        tokio::spawn(async move {
            while let Ok((mut s, _)) = silent.accept().await {
                let _ = s.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n").await;
            }
        });
        let e = get(with(10_000).build().unwrap(), format!("https://{addr}/")).await;
        assert_eq!(code(&e), "fetch.tls", "{e}");
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
