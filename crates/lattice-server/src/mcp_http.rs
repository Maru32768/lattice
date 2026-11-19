//! MCP over Streamable HTTP for the app: one endpoint on this PC's loopback, a bearer token per registration, and the
//! registration read again at every request, so a new token, a new role and a deletion hold from the next one. The
//! JSON-RPC itself is `mcp::step`, shared with `lattice-cli mcp`.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::{Arc, Mutex, MutexGuard};

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use lattice_core::chain::LlmChain;
use lattice_core::embed::LocalE5;
use lattice_core::jobs::Providers;
use lattice_core::mcp::{self, Registration, Role};
use lattice_core::mobile::{Effects, blocking};
use lattice_core::store::{Store, sha256_hex};
use serde_json::Value;

use crate::mcp::{Message, PROTOCOL_VERSIONS, Step, step, tool_reply};
use crate::ops::{self, Ctx, Op, Out};
use crate::{OnApplied, bearer, error, internal_error};

/// Loopback only: another machine on the network cannot even connect.
pub const ADDR: SocketAddr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 8788));
const ENDPOINT: &str = "/mcp";
const SESSION: &str = "mcp-session-id";
const VERSION: &str = "mcp-protocol-version";
/// More than one PC's agents keep open. Past it the session idle longest goes, and its client initializes again.
const MAX_SESSIONS: usize = 64;
const READ_ONLY: &str = "This tool changes the library, and this connection may only read it. The user can change that in Lattice: Settings › MCP.";
const NO_DELETING: &str = "Deleting over MCP needs the user's approval in Lattice, which this version cannot ask for. Nothing was deleted.";

/// What the settings screen copies for a registration. User scope: the library is the user's, not one project's.
pub fn add_command(token: &str) -> String {
    format!("claude mcp add --transport http --scope user lattice http://{ADDR}{ENDPOINT} --header \"Authorization: Bearer {token}\"")
}

#[derive(Clone)]
struct McpState {
    store: Arc<Store>,
    providers: Arc<Providers<LlmChain, LocalE5>>,
    on_applied: OnApplied,
    sessions: Arc<Mutex<Sessions>>,
}

#[derive(Default)]
struct Sessions {
    by_id: HashMap<String, Session>,
    /// Counts requests, so that the session idle longest is the one used longest ago, ties impossible.
    clock: u64,
}

struct Session {
    /// The hash of the token that opened it. A session answers only to that token, so a regenerated or deleted
    /// token leaves it unreachable without anything having to end it.
    key: String,
    used: u64,
}

/// `/mcp` for the registrations in `store`. Writes report what they changed through `on_applied`, as the phone's do.
pub fn router(store: Arc<Store>, providers: Arc<Providers<LlmChain, LocalE5>>, on_applied: OnApplied) -> Router {
    // GET (a stream from the server) and every other method get 405 from the method router.
    Router::new().route(ENDPOINT, post(post_message).delete(end_session)).layer(middleware::from_fn(refuse_browsers)).with_state(McpState {
        store,
        providers,
        on_applied,
        sessions: Arc::default(),
    })
}

/// A page in a browser on this PC could reach the server through a name pointed at 127.0.0.1 (DNS rebinding). Agents
/// send no `Origin`; browsers send one with every POST, so a request that has one is refused before anything else.
async fn refuse_browsers(request: Request, next: Next) -> Response {
    if request.headers().contains_key(header::ORIGIN) {
        return error(StatusCode::FORBIDDEN, "forbidden");
    }
    next.run(request).await
}

/// The caller's registration as stored now, and the key its sessions are kept under.
async fn caller(st: &McpState, headers: &HeaderMap) -> Result<(Registration, String), Box<Response>> {
    let Some(token) = bearer(headers) else {
        return Err(Box::new(error(StatusCode::UNAUTHORIZED, "unauthorized")));
    };
    let key = sha256_hex(&token);
    let store = st.store.clone();
    match blocking(move || mcp::authenticate(&store, &token)).await {
        Ok(Some(registration)) => Ok((registration, key)),
        Ok(None) => Err(Box::new(error(StatusCode::UNAUTHORIZED, "unauthorized"))),
        Err(e) => Err(Box::new(internal_error(&e))),
    }
}

fn session_id(headers: &HeaderMap) -> Option<&str> {
    headers.get(SESSION).and_then(|v| v.to_str().ok())
}

async fn post_message(State(st): State<McpState>, headers: HeaderMap, body: Bytes) -> Response {
    let (registration, key) = match caller(&st, &headers).await {
        Ok(c) => c,
        Err(response) => return *response,
    };
    // Absent, it is 2025-03-26 by the spec.
    if headers.get(VERSION).is_some_and(|v| !v.to_str().is_ok_and(|v| PROTOCOL_VERSIONS.contains(&v))) {
        return error(StatusCode::BAD_REQUEST, "unsupported MCP-Protocol-Version");
    }
    let message = match Message::parse(&body) {
        Ok(m) => m,
        Err(reply) => return json(StatusCode::BAD_REQUEST, &reply),
    };
    let opened = if message.is_initialize() {
        match st.open(&key) {
            Ok(id) => Some(id),
            Err(e) => return internal_error(&e),
        }
    } else {
        match session_id(&headers) {
            None => return error(StatusCode::BAD_REQUEST, "no Mcp-Session-Id: initialize first"),
            Some(id) if !st.holds(id, &key) => return error(StatusCode::NOT_FOUND, "no such session: initialize again"),
            Some(_) => None,
        }
    };
    let reply = match step(&message, registration.role) {
        Step::Silent => return StatusCode::ACCEPTED.into_response(),
        Step::Reply(reply) => reply,
        Step::Call { id, op } => tool_reply(id, st.call(&registration, op).await),
    };
    let mut response = json(StatusCode::OK, &reply);
    if let Some(id) = opened.and_then(|id| HeaderValue::from_str(&id).ok()) {
        response.headers_mut().insert(SESSION, id);
    }
    response
}

async fn end_session(State(st): State<McpState>, headers: HeaderMap) -> Response {
    let key = match caller(&st, &headers).await {
        Ok((_, key)) => key,
        Err(response) => return *response,
    };
    match session_id(&headers) {
        None => error(StatusCode::BAD_REQUEST, "no Mcp-Session-Id"),
        Some(id) if st.close(id, &key) => StatusCode::NO_CONTENT.into_response(),
        Some(_) => error(StatusCode::NOT_FOUND, "no such session"),
    }
}

fn json(status: StatusCode, body: &Value) -> Response {
    (status, [(header::CONTENT_TYPE, "application/json")], body.to_string()).into_response()
}

/// The role a call runs with, or why it may not run, in words an agent can pass on.
fn permit(role: Role, op: &Op) -> Result<Role, String> {
    match op.role() {
        // shortcut: every deletion is refused until the app can ask the user before each one.
        Role::Delete => Err(NO_DELETING.into()),
        Role::Edit if role < Role::Edit => Err(READ_ONLY.into()),
        // Below deletion, for `ops::run` to check again.
        Role::Read | Role::Edit => Ok(role.min(Role::Edit)),
    }
}

impl McpState {
    fn sessions(&self) -> MutexGuard<'_, Sessions> {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn open(&self, key: &str) -> Result<String, String> {
        let id = mcp::random_hex()?;
        let mut s = self.sessions();
        if s.by_id.len() >= MAX_SESSIONS
            && let Some(idle) = s.by_id.iter().min_by_key(|(_, session)| session.used).map(|(id, _)| id.clone())
        {
            s.by_id.remove(&idle);
        }
        s.clock += 1;
        let used = s.clock;
        s.by_id.insert(id.clone(), Session { key: key.to_string(), used });
        Ok(id)
    }

    /// Whether `id` is a live session opened with this token; another token's session is as unknown as a made-up id.
    fn holds(&self, id: &str, key: &str) -> bool {
        let mut s = self.sessions();
        let now = s.clock + 1;
        match s.by_id.get_mut(id) {
            Some(session) if session.key == key => {
                session.used = now;
                s.clock = now;
                true
            }
            _ => false,
        }
    }

    fn close(&self, id: &str, key: &str) -> bool {
        let mut s = self.sessions();
        s.by_id.get(id).is_some_and(|session| session.key == key) && s.by_id.remove(id).is_some()
    }

    /// Runs a tool call, then tells the app what may have changed: after a failure too, since one can stop halfway,
    /// and a reload that finds nothing new costs little.
    async fn call(&self, registration: &Registration, op: Op) -> Result<Out, String> {
        let role = permit(registration.role, &op)?;
        let effects = op.effects();
        let outcome = ops::run(&Ctx { store: self.store.clone(), providers: self.providers.clone(), role }, op).await;
        if effects != Effects::default() {
            (self.on_applied)(&effects);
        }
        outcome
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use lattice_core::mcp::Edit;
    use lattice_core::store::{ArticleFilter, ArticleSort};
    use serde_json::json;
    use tower::ServiceExt;

    struct Fixture {
        app: Router,
        store: Arc<Store>,
        applied: Arc<Mutex<Vec<Option<i64>>>>,
    }

    fn providers(store: &Store) -> Arc<Providers<LlmChain, LocalE5>> {
        let llm = LlmChain::new(lattice_core::chain::load(store).unwrap());
        let embedder = LocalE5::offline(std::env::temp_dir().join("lattice-server-test-models"));
        Arc::new(Providers { llm, embedder, http: lattice_core::fetch::client() })
    }

    fn fixture() -> Fixture {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let applied = Arc::new(Mutex::new(Vec::new()));
        let log = applied.clone();
        let app = router(store.clone(), providers(&store), Arc::new(move |e: &Effects| log.lock().unwrap().push(e.article)));
        Fixture { app, store, applied }
    }

    impl Fixture {
        fn register(&self, name: &str, role: Role) -> Registration {
            mcp::edit(&self.store, &Edit::Create { name: name.into(), role }).unwrap();
            self.reread(name)
        }

        fn reread(&self, name: &str) -> Registration {
            mcp::registrations(&self.store).unwrap().into_iter().find(|r| r.name == name).unwrap()
        }

        async fn send(&self, method: &str, token: Option<&str>, session: Option<&str>, headers: &[(&str, &str)], body: Value) -> Response {
            let mut request = HttpRequest::builder().method(method).uri(ENDPOINT).header(header::CONTENT_TYPE, "application/json");
            if let Some(t) = token {
                request = request.header(header::AUTHORIZATION, format!("Bearer {t}"));
            }
            if let Some(s) = session {
                request = request.header(SESSION, s);
            }
            for (name, value) in headers {
                request = request.header(*name, *value);
            }
            let body = if body.is_null() {
                Body::empty()
            } else {
                Body::from(body.to_string())
            };
            self.app.clone().oneshot(request.body(body).unwrap()).await.unwrap()
        }

        async fn post(&self, token: &str, session: Option<&str>, body: Value) -> Response {
            self.send("POST", Some(token), session, &[], body).await
        }

        /// A session as a client opens one: `initialize`, then its id.
        async fn initialize(&self, token: &str) -> String {
            let r = self.post(token, None, json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": { "protocolVersion": "2025-11-25" } })).await;
            assert_eq!(r.status(), StatusCode::OK);
            r.headers()[SESSION].to_str().unwrap().to_string()
        }

        async fn call(&self, token: &str, session: &str, name: &str, arguments: Value) -> Value {
            let r = self
                .post(token, Some(session), json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": name, "arguments": arguments } }))
                .await;
            assert_eq!(r.status(), StatusCode::OK);
            body_of(r).await["result"].clone()
        }

        async fn tool_count(&self, token: &str, session: &str) -> usize {
            let r = self.post(token, Some(session), json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })).await;
            body_of(r).await["result"]["tools"].as_array().unwrap().len()
        }

        fn saved(&self, url: &str) -> i64 {
            self.store.upsert_pending(url, url, "example.com").unwrap().0
        }

        fn titles(&self) -> Vec<(i64, Option<String>)> {
            let rows = self.store.list_articles_sorted(&ArticleFilter::All, ArticleSort::SavedDesc).unwrap();
            rows.into_iter().map(|a| (a.id, a.title)).collect()
        }
    }

    async fn body_of(r: Response) -> Value {
        serde_json::from_slice(&axum::body::to_bytes(r.into_body(), usize::MAX).await.unwrap()).unwrap()
    }

    #[test]
    fn it_listens_on_this_pc_only() {
        assert!(ADDR.ip().is_loopback() && ADDR.port() == 8788);
        assert_eq!(
            add_command("t0k"),
            r#"claude mcp add --transport http --scope user lattice http://127.0.0.1:8788/mcp --header "Authorization: Bearer t0k""#
        );
    }

    #[tokio::test]
    async fn only_a_registered_token_gets_in_and_never_from_a_browser() {
        let f = fixture();
        let r = f.register("Claude Code", Role::Read);
        let init = json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize" });
        assert_eq!(f.send("POST", None, None, &[], init.clone()).await.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(f.post("wrong", None, init.clone()).await.status(), StatusCode::UNAUTHORIZED);
        for method in ["POST", "GET", "DELETE", "OPTIONS"] {
            let from_a_page = f.send(method, Some(&r.token), None, &[("origin", "http://127.0.0.1:8788")], init.clone()).await;
            assert_eq!(from_a_page.status(), StatusCode::FORBIDDEN, "{method}");
        }
        assert_eq!(f.post(&r.token, None, init).await.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn a_session_starts_at_initialize_and_belongs_to_its_token() {
        let f = fixture();
        let (a, b) = (f.register("A", Role::Read), f.register("B", Role::Read));
        let r = f.post(&a.token, None, json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": { "protocolVersion": "2025-11-25" } })).await;
        let session = r.headers()[SESSION].to_str().unwrap().to_string();
        assert!(session.len() == 64 && session.bytes().all(|c| c.is_ascii_hexdigit()), "{session}");
        let result = body_of(r).await["result"].clone();
        assert_eq!((result["serverInfo"]["name"].as_str(), result["protocolVersion"].as_str()), (Some("lattice"), Some("2025-11-25")));

        let ping = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" });
        assert_eq!(f.post(&a.token, Some(&session), ping.clone()).await.status(), StatusCode::OK);
        assert_eq!(f.post(&a.token, None, ping.clone()).await.status(), StatusCode::BAD_REQUEST, "no session");
        assert_eq!(f.post(&a.token, Some("made-up"), ping.clone()).await.status(), StatusCode::NOT_FOUND);
        assert_eq!(f.post(&b.token, Some(&session), ping.clone()).await.status(), StatusCode::NOT_FOUND, "another registration's");
        let notification = f.post(&a.token, Some(&session), json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;
        assert_eq!(notification.status(), StatusCode::ACCEPTED);
        assert!(axum::body::to_bytes(notification.into_body(), usize::MAX).await.unwrap().is_empty());
        let old = f.send("POST", Some(&a.token), Some(&session), &[(VERSION, "2024-01-01")], ping.clone()).await;
        assert_eq!(old.status(), StatusCode::BAD_REQUEST, "a protocol version this server does not speak");
        let current = f.send("POST", Some(&a.token), Some(&session), &[(VERSION, "2025-06-18")], ping.clone()).await;
        assert_eq!(current.status(), StatusCode::OK);
        assert_eq!(f.post(&a.token, Some(&session), json!("ping")).await.status(), StatusCode::BAD_REQUEST);
        assert_eq!(f.send("GET", Some(&a.token), Some(&session), &[], Value::Null).await.status(), StatusCode::METHOD_NOT_ALLOWED);

        assert_eq!(f.send("DELETE", Some(&b.token), Some(&session), &[], Value::Null).await.status(), StatusCode::NOT_FOUND);
        assert_eq!(f.send("DELETE", Some(&a.token), Some(&session), &[], Value::Null).await.status(), StatusCode::NO_CONTENT);
        assert_eq!(f.post(&a.token, Some(&session), ping).await.status(), StatusCode::NOT_FOUND, "ended");
    }

    #[tokio::test]
    async fn a_changed_registration_holds_from_the_next_request() {
        let f = fixture();
        let r = f.register("Claude Code", Role::Read);
        let id = f.saved("https://example.com/a");
        let session = f.initialize(&r.token).await;
        assert_eq!(f.call(&r.token, &session, "tag", json!({ "id": id, "name": "later" })).await["isError"], true);

        mcp::edit(&f.store, &Edit::SetRole { id: r.id.clone(), role: Role::Edit }).unwrap();
        assert_eq!(f.call(&r.token, &session, "tag", json!({ "id": id, "name": "later" })).await["isError"], false, "the same session");

        mcp::edit(&f.store, &Edit::Regenerate { id: r.id.clone() }).unwrap();
        let renewed = f.reread("Claude Code");
        let ping = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" });
        assert_eq!(f.post(&r.token, Some(&session), ping.clone()).await.status(), StatusCode::UNAUTHORIZED, "the old token");
        assert_eq!(f.post(&renewed.token, Some(&session), ping.clone()).await.status(), StatusCode::NOT_FOUND, "the old token's session");
        let session = f.initialize(&renewed.token).await;

        mcp::edit(&f.store, &Edit::Delete { id: r.id }).unwrap();
        assert_eq!(f.post(&renewed.token, Some(&session), ping).await.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn each_role_lists_its_tools_and_runs_no_deletion() {
        let f = fixture();
        let id = f.saved("https://example.com/a");
        let mut counts = Vec::new();
        for (name, role) in [("read", Role::Read), ("edit", Role::Edit), ("delete", Role::Delete)] {
            let r = f.register(name, role);
            let session = f.initialize(&r.token).await;
            counts.push(f.tool_count(&r.token, &session).await);
            let refused = f.call(&r.token, &session, "delete_article", json!({ "id": id })).await;
            assert_eq!(refused["isError"], true, "{name}");
        }
        assert_eq!(counts, [10, 30, 35]);
        assert_eq!(f.titles().len(), 1, "nothing was deleted");
        assert!(f.applied.lock().unwrap().is_empty(), "a refused call changes nothing to show");
    }

    #[tokio::test]
    async fn a_write_tells_the_app_what_to_show_and_a_read_does_not() {
        let f = fixture();
        let r = f.register("Claude Code", Role::Edit);
        let id = f.saved("https://example.com/a");
        let session = f.initialize(&r.token).await;
        assert_eq!(f.call(&r.token, &session, "get", json!({ "id": id })).await["isError"], false);
        assert!(f.applied.lock().unwrap().is_empty());
        let renamed = f.call(&r.token, &session, "rename_article", json!({ "id": id, "title": "Mine" })).await;
        assert_eq!(renamed["isError"], false, "{renamed}");
        assert_eq!(f.titles(), [(id, Some("Mine".to_string()))]);
        assert_eq!(*f.applied.lock().unwrap(), [Some(id)]);
        let wrong = f.call(&r.token, &session, "rename_article", json!({ "id": id, "name": "Typo" })).await;
        assert_eq!(wrong["isError"], true, "an argument the tool does not take");
        assert_eq!(f.applied.lock().unwrap().len(), 1, "nothing ran");
    }

    #[test]
    fn the_session_idle_longest_makes_room() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let st = McpState { providers: providers(&store), store, on_applied: Arc::new(|_| {}), sessions: Arc::default() };
        let first = st.open("k").unwrap();
        let rest: Vec<String> = (1..MAX_SESSIONS).map(|_| st.open("k").unwrap()).collect();
        assert!(st.holds(&first, "k"), "used again, so no longer the idlest");
        let newest = st.open("k").unwrap();
        assert_eq!(st.sessions().by_id.len(), MAX_SESSIONS);
        assert!(st.holds(&first, "k") && st.holds(&newest, "k"));
        assert!(!st.holds(&rest[0], "k"), "the one idle longest went");
    }
}
