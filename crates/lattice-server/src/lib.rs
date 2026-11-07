//! The PC's server for the phone (G47, design-review §32): the page and the library's documents.
//! It speaks plain HTTP. On the local network that is what there is; beyond it a tunnel in front
//! (Tailscale Serve, cloudflared) provides TLS, so this crate never handles a certificate.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use lattice_core::mobile;
use lattice_core::store::Store;
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

/// A built file of the page (`src/mobile`, built by `npm run build:overlay`).
pub struct Asset {
    pub path: &'static str,
    pub content_type: &'static str,
    pub bytes: &'static [u8],
}

macro_rules! asset {
    ($path:literal, $type:literal) => {
        Asset { path: $path, content_type: $type, bytes: include_bytes!(concat!("../mobile-dist/", $path)) }
    };
}

pub const ASSETS: &[Asset] = &[
    asset!("index.html", "text/html; charset=utf-8"),
    asset!("mobile.js", "text/javascript; charset=utf-8"),
    asset!("mobile.css", "text/css; charset=utf-8"),
    asset!("manifest.webmanifest", "application/manifest+json"),
    asset!("icon-256.png", "image/png"),
    asset!("icon-512.png", "image/png"),
];

/// Articles are untrusted. The page renders them as text; this keeps a mistake there from running or loading anything.
/// React sets `style` through the CSSOM, which this allows; e2e/mobile-built.spec.ts runs the built page under it.
const CSP: &str = "default-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

pub fn router(store: Arc<Store>) -> Router {
    Router::new()
        .route("/api/ping", get(|| async { json_headers(Response::new(Body::from("{}"))) }))
        .route("/api/index", get(index))
        .route("/api/articles/{id}", get(article))
        .route_layer(middleware::from_fn_with_state(store.clone(), require_token))
        .fallback(page)
        .with_state(store)
}

async fn require_token(State(store): State<Arc<Store>>, request: Request, next: Next) -> Response {
    let token = request.headers().get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).map(str::to_owned);
    let Some(token) = token else {
        return error(StatusCode::UNAUTHORIZED, "unauthorized");
    };
    match blocking(move || mobile::token_accepted(&store, &token)).await {
        Ok(true) => next.run(request).await,
        Ok(false) => error(StatusCode::UNAUTHORIZED, "unauthorized"),
        Err(e) => internal_error(&e),
    }
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, [(header::CONTENT_TYPE, "application/json")], json!({ "error": message }).to_string()).into_response()
}

/// The details stay in the log: a phone can do nothing with them.
fn internal_error(e: &str) -> Response {
    log::warn!("mobile server: {e}");
    error(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}

fn accepts_gzip(headers: &HeaderMap) -> bool {
    let offers_gzip = |value: &str| {
        let mut parts = value.split(';').map(str::trim);
        parts.next().is_some_and(|name| name.eq_ignore_ascii_case("gzip"))
            && !parts.any(|p| p.replace(' ', "").starts_with("q=0") && p.trim_start_matches(['q', '=', '0', '.', ' ']).is_empty())
    };
    headers.get(header::ACCEPT_ENCODING).and_then(|v| v.to_str().ok()).is_some_and(|v| v.split(',').any(offers_gzip))
}

/// Runs what would hold up the async workers: a store call may wait for its lock behind a job, and compressing takes time.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// `body`, compressed when the client takes that and `compress` says it is worth it.
async fn encoded(request: &HeaderMap, content_type: &'static str, body: Bytes, compress: bool) -> Response {
    let gz = if compress && accepts_gzip(request) {
        let raw = body.clone();
        blocking(move || mobile::gzip(&raw).map_err(|e| e.to_string())).await.ok()
    } else {
        None
    };
    let mut response = match gz {
        Some(gz) => {
            let mut r = Response::new(Body::from(gz));
            r.headers_mut().insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
            r
        }
        None => Response::new(Body::from(body)),
    };
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response.headers_mut().insert(header::VARY, HeaderValue::from_static("accept-encoding"));
    response
}

/// A document of the library: never kept by a cache along the way, as the token guards it.
fn json_headers(mut response: Response) -> Response {
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn json_response(request: &HeaderMap, body: Vec<u8>) -> Response {
    json_headers(encoded(request, "application/json", body.into(), true).await)
}

async fn index(State(store): State<Arc<Store>>, headers: HeaderMap) -> Response {
    match blocking(move || serde_json::to_vec(&mobile::index(&store)?).map_err(|e| e.to_string())).await {
        Ok(body) => json_response(&headers, body).await,
        Err(e) => internal_error(&e),
    }
}

async fn article(State(store): State<Arc<Store>>, Path(id): Path<i64>, headers: HeaderMap) -> Response {
    match blocking(move || mobile::article(&store, id)?.map(|doc| serde_json::to_vec(&doc).map_err(|e| e.to_string())).transpose()).await {
        Ok(Some(body)) => json_response(&headers, body).await,
        Ok(None) => error(StatusCode::NOT_FOUND, "no such article"),
        Err(e) => internal_error(&e),
    }
}

async fn page(method: Method, headers: HeaderMap, request: Request) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let path = request.uri().path().trim_start_matches('/');
    let path = if path.is_empty() {
        "index.html"
    } else {
        path
    };
    let Some(asset) = ASSETS.iter().find(|a| a.path == path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut response = encoded(&headers, asset.content_type, Bytes::from_static(asset.bytes), !asset.content_type.starts_with("image/")).await;
    let h = response.headers_mut();
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(CSP));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    // The page's address is private: a link to an article must not hand it to that site.
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    response
}

/// A running server. Dropping it stops it as `stop` does, without waiting.
pub struct Server {
    pub addr: SocketAddr,
    stop: oneshot::Sender<()>,
    task: JoinHandle<()>,
}

/// Binds `addr` and serves `router` in a task of the current Tokio runtime.
pub async fn start(addr: SocketAddr, router: Router) -> std::io::Result<Server> {
    let listener = TcpListener::bind(addr).await?;
    let addr = listener.local_addr()?;
    let (stop, stopped) = oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        let shutdown = async move {
            let _ = stopped.await;
        };
        if let Err(e) = axum::serve(listener, router).with_graceful_shutdown(shutdown).await {
            log::warn!("mobile server: {e}");
        }
    });
    Ok(Server { addr, stop, task })
}

impl Server {
    /// Stops accepting at once and waits a moment for requests in progress. A longer one finishes on its own.
    pub async fn stop(self) {
        let _ = self.stop.send(());
        let _ = tokio::time::timeout(Duration::from_secs(2), self.task).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request as HttpRequest;
    use tower::ServiceExt;

    fn app() -> (Router, Arc<Store>, String) {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let token = mobile::token(&store).unwrap();
        (router(store.clone()), store, token)
    }

    async fn get_with(app: &Router, path: &str, token: Option<&str>) -> Response {
        let mut request = HttpRequest::get(path);
        if let Some(t) = token {
            request = request.header(header::AUTHORIZATION, format!("Bearer {t}"));
        }
        app.clone().oneshot(request.body(Body::empty()).unwrap()).await.unwrap()
    }

    async fn body(r: Response) -> Vec<u8> {
        axum::body::to_bytes(r.into_body(), usize::MAX).await.unwrap().to_vec()
    }

    #[tokio::test]
    async fn the_api_needs_the_token() {
        let (app, _, token) = app();
        for path in ["/api/ping", "/api/index", "/api/articles/1"] {
            assert_eq!(get_with(&app, path, None).await.status(), StatusCode::UNAUTHORIZED, "{path}");
            assert_eq!(get_with(&app, path, Some("wrong")).await.status(), StatusCode::UNAUTHORIZED, "{path}");
        }
        assert_eq!(get_with(&app, "/api/ping", Some(&token)).await.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn a_regenerated_token_takes_over_at_once_without_a_restart() {
        let (app, store, old) = app();
        let new = mobile::regenerate_token(&store).unwrap();
        assert_eq!(get_with(&app, "/api/ping", Some(&old)).await.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(get_with(&app, "/api/ping", Some(&new)).await.status(), StatusCode::OK);
    }

    #[test]
    fn gzip_is_used_only_when_the_client_offers_it() {
        let accepts = |v: &str| accepts_gzip(&HeaderMap::from_iter([(header::ACCEPT_ENCODING, HeaderValue::from_str(v).unwrap())]));
        for yes in ["gzip", "GZIP", "br, gzip", "gzip;q=0.5", "gzip; q=1", "deflate , gzip ; q=0.1"] {
            assert!(accepts(yes), "{yes}");
        }
        for no in ["identity", "br", "gzip;q=0", "gzip; q=0.0", "x-gzip"] {
            assert!(!accepts(no), "{no}");
        }
        assert!(!accepts_gzip(&HeaderMap::new()));
    }

    #[tokio::test]
    async fn serves_the_index_and_articles_as_json() {
        let (app, store, token) = app();
        let (id, _) = store.upsert_pending("https://example.com/a", "https://example.com/a", "example.com").unwrap();
        let index = get_with(&app, "/api/index", Some(&token)).await;
        assert_eq!(index.headers()[header::CACHE_CONTROL], "no-store");
        let index: serde_json::Value = serde_json::from_slice(&body(index).await).unwrap();
        assert_eq!(index["articles"][0]["id"], id);
        let doc: serde_json::Value = serde_json::from_slice(&body(get_with(&app, &format!("/api/articles/{id}"), Some(&token)).await).await).unwrap();
        assert_eq!(doc["article"]["original_url"], "https://example.com/a");
        assert_eq!(get_with(&app, &format!("/api/articles/{}", id + 1), Some(&token)).await.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn compresses_for_a_client_that_accepts_it() {
        let (app, _, token) = app();
        let request = HttpRequest::get("/api/index").header(header::AUTHORIZATION, format!("Bearer {token}")).header(header::ACCEPT_ENCODING, "br, gzip");
        let response = app.oneshot(request.body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(response.headers()[header::CONTENT_ENCODING], "gzip");
        assert_eq!(body(response).await[..2], [0x1f, 0x8b]);
    }

    #[tokio::test]
    async fn serves_the_page_without_the_token_and_guarded() {
        let (app, _, _) = app();
        let page = get_with(&app, "/", None).await;
        assert_eq!(page.status(), StatusCode::OK);
        assert!(page.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap().contains("default-src 'self'"));
        assert_eq!(page.headers()[header::REFERRER_POLICY], "no-referrer");
        assert!(String::from_utf8(body(page).await).unwrap().contains("mobile.js"));
        for path in ["/../Cargo.toml", "/secret", "/api/nothing"] {
            assert_eq!(get_with(&app, path, None).await.status(), StatusCode::NOT_FOUND, "{path}");
        }
    }

    #[test]
    fn every_built_file_is_served() {
        let dist = concat!(env!("CARGO_MANIFEST_DIR"), "/mobile-dist");
        for file in std::fs::read_dir(dist).unwrap() {
            let name = file.unwrap().file_name().into_string().unwrap();
            assert!(ASSETS.iter().any(|a| a.path == name), "add {name} to ASSETS");
        }
    }

    #[tokio::test]
    async fn a_stopped_server_frees_its_port_for_the_next() {
        let (app, _, _) = app();
        let first = start("127.0.0.1:0".parse().unwrap(), app.clone()).await.unwrap();
        let addr = first.addr;
        first.stop().await;
        let second = start(addr, app.clone()).await.unwrap();
        assert_eq!(second.addr, addr);
        drop(second);
        for _ in 0..100 {
            if TcpListener::bind(addr).await.is_ok() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("dropping a server leaves its port taken");
    }
}
