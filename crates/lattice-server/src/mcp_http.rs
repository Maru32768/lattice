//! MCP over Streamable HTTP for the app: one endpoint on this PC's loopback, a bearer token per registration, and the
//! registration read again at every request, so a new token, a new role and a deletion hold from the next one. The
//! JSON-RPC itself is `mcp::step`, shared with `lattice-cli mcp`.

use std::collections::{HashMap, VecDeque};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

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
use lattice_core::mcp::{self, Registration, Role, Scope};
use lattice_core::mobile::{Effects, blocking};
use lattice_core::store::{Store, random_hex, sha256_hex};
use serde::Serialize;
use ts_rs::TS;

use crate::mcp::{Message, PROTOCOL_VERSIONS, Step, step, tool_reply};
use crate::ops::{self, Ctx, Op, Out};
use crate::{OnApplied, bearer, error, internal_error, json};

/// Loopback only: another machine on the network cannot even connect.
pub const ADDR: SocketAddr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, mcp::PORT));
const ENDPOINT: &str = "/mcp";
const SESSION: &str = "mcp-session-id";
const VERSION: &str = "mcp-protocol-version";
/// More than one PC's agents keep open. Past it the session idle longest goes, and its client initializes again.
const MAX_SESSIONS: usize = 64;
/// Per registration: enough to see what an agent has been doing, few enough to keep in memory.
const MAX_CALLS: usize = 20;
/// What an agent names (its client, a tool it asked for) is cut to this before the settings screen shows it.
const MAX_NAME_CHARS: usize = 64;
const READ_ONLY: &str = "This tool changes the library, and this connection may only read it. The user can change that in Lattice: Settings › AI agents (MCP).";
const NO_DELETING: &str = "Deleting over MCP needs the user's approval in Lattice, which this version cannot ask for. Nothing was deleted.";

/// What the settings screen copies for a registration. One name in every scope, so a project's own takes the place of the
/// user-wide one there, and an agent's tools are `mcp__lattice__*` whichever it holds.
pub fn add_command(token: &str, scope: Scope) -> String {
    let scope = scope.as_str();
    format!("claude mcp add --transport http --scope {scope} lattice http://{ADDR}{ENDPOINT} --header \"Authorization: Bearer {token}\"")
}

/// What takes a registration out of Claude Code again: Claude Code refuses a second `add` under the same name.
pub fn remove_command(scope: Scope) -> String {
    format!("claude mcp remove lattice -s {}", scope.as_str())
}

#[derive(Clone)]
struct McpState {
    store: Arc<Store>,
    providers: Arc<Providers<LlmChain, LocalE5>>,
    on_applied: OnApplied,
    activity: Arc<Activity>,
}

/// What the settings screen shows of the server's use. Memory only: the app makes a new one each time it starts the
/// server, so switching it off and on, or quitting, forgets it.
pub struct Activity {
    sessions: Mutex<Sessions>,
    /// By registration id, oldest first.
    calls: Mutex<HashMap<String, VecDeque<CallInfo>>>,
    changed: Box<dyn Fn() + Send + Sync>,
}

/// An open session as the settings screen shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, rename = "McpSession")]
pub struct SessionInfo {
    /// The name and version the agent gave in `initialize`: its own words, shown as text only.
    pub client: Option<String>,
    pub started_ms: u64,
    /// When its last request came.
    pub last_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, rename = "McpOutcome")]
pub enum Outcome {
    Succeeded,
    /// The tool ran and failed, or the call named no tool this server has or gave it bad arguments.
    Failed,
    /// Above the registration's role, or a deletion.
    Refused,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, rename = "McpCall")]
pub struct CallInfo {
    pub at_ms: u64,
    pub tool: String,
    pub outcome: Outcome,
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
    /// The clock when it opened: sessions opened in the same millisecond still keep their order on the screen.
    opened: u64,
    client: Option<String>,
    started_ms: u64,
    last_ms: u64,
}

/// `/mcp` for the registrations in `store`. Writes report what they changed through `on_applied`, as the phone's do;
/// sessions and calls go to `activity`.
pub fn router(store: Arc<Store>, providers: Arc<Providers<LlmChain, LocalE5>>, on_applied: OnApplied, activity: Arc<Activity>) -> Router {
    // GET (a stream from the server) and every other method get 405 from the method router.
    Router::new().route(ENDPOINT, post(post_message).delete(end_session)).layer(middleware::from_fn(refuse_browsers)).with_state(McpState {
        store,
        providers,
        on_applied,
        activity,
    })
}

/// A page in a browser on this PC could reach the server through a name pointed at 127.0.0.1 (DNS rebinding). Agents
/// send no `Origin` and name the server by its address; a browser sends an `Origin` with every POST, and the page's own
/// name as `Host` even where an old engine leaves `Origin` out. Either refuses the request before anything else.
async fn refuse_browsers(request: Request, next: Next) -> Response {
    let headers = request.headers();
    let named_otherwise = headers.get(header::HOST).is_some_and(|host| !host.to_str().is_ok_and(names_this_server));
    if headers.contains_key(header::ORIGIN) || named_otherwise {
        return error(StatusCode::FORBIDDEN, "forbidden");
    }
    next.run(request).await
}

fn names_this_server(host: &str) -> bool {
    let port = ADDR.port();
    [format!("127.0.0.1:{port}"), format!("localhost:{port}")].iter().any(|name| name.eq_ignore_ascii_case(host))
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
        match st.activity.open(&key, message.client().as_deref().map(clip)) {
            Ok(id) => Some(id),
            Err(e) => return internal_error(&e),
        }
    } else {
        match session_id(&headers) {
            None => return error(StatusCode::BAD_REQUEST, "no Mcp-Session-Id: initialize first"),
            Some(id) if !st.activity.holds(id, &key) => return error(StatusCode::NOT_FOUND, "no such session: initialize again"),
            Some(_) => None,
        }
    };
    let tool = message.tool().map(clip);
    let reply = match step(&message, registration.role) {
        Step::Silent => return StatusCode::ACCEPTED.into_response(),
        Step::Reply(reply) => {
            // A tools/call answered without running: a tool this server lacks, or arguments that do not fit it.
            if let Some(tool) = &tool {
                st.activity.record(&registration.id, tool, Outcome::Failed);
            }
            reply
        }
        Step::Call { id, op } => {
            // Its own task: an agent that hangs up mid-call would otherwise drop the operation halfway, leaving a job it
            // claimed claimed until the app quits, and the app never told what was written.
            let st = st.clone();
            let (role, who, tool) = (registration.role, registration.id, tool.unwrap_or_default());
            tool_reply(id, tokio::spawn(async move { st.call(role, op, &who, &tool).await }).await.unwrap_or_else(|e| Err(e.to_string())))
        }
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
        Some(id) if st.activity.close(id, &key) => StatusCode::NO_CONTENT.into_response(),
        Some(_) => error(StatusCode::NOT_FOUND, "no such session"),
    }
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

fn clip(name: &str) -> String {
    name.chars().take(MAX_NAME_CHARS).collect()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl Activity {
    /// `changed` runs after each change, with no lock held, so it may read the activity again.
    pub fn new(changed: impl Fn() + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self { sessions: Mutex::default(), calls: Mutex::default(), changed: Box::new(changed) })
    }

    /// The sessions `registration`'s current token holds, oldest first, and its latest calls, newest first. A session
    /// opened with a token since regenerated is gone from here, as it is to the server.
    pub fn of(&self, registration: &Registration) -> (Vec<SessionInfo>, Vec<CallInfo>) {
        let key = sha256_hex(&registration.token);
        let sessions = {
            let table = lock(&self.sessions);
            let mut held: Vec<&Session> = table.by_id.values().filter(|s| s.key == key).collect();
            held.sort_by_key(|s| s.opened);
            held.into_iter().map(|s| SessionInfo { client: s.client.clone(), started_ms: s.started_ms, last_ms: s.last_ms }).collect()
        };
        let calls = lock(&self.calls).get(&registration.id).map(|log| log.iter().rev().cloned().collect()).unwrap_or_default();
        (sessions, calls)
    }

    fn open(&self, key: &str, client: Option<String>) -> Result<String, String> {
        let id = lock(&self.sessions).open(key, client)?;
        (self.changed)();
        Ok(id)
    }

    fn holds(&self, id: &str, key: &str) -> bool {
        let held = lock(&self.sessions).holds(id, key);
        if held {
            (self.changed)();
        }
        held
    }

    fn close(&self, id: &str, key: &str) -> bool {
        let closed = lock(&self.sessions).close(id, key);
        if closed {
            (self.changed)();
        }
        closed
    }

    fn record(&self, registration: &str, tool: &str, outcome: Outcome) {
        {
            let mut calls = lock(&self.calls);
            let log = calls.entry(registration.to_string()).or_default();
            if log.len() == MAX_CALLS {
                log.pop_front();
            }
            log.push_back(CallInfo { at_ms: now_ms(), tool: tool.to_string(), outcome });
        }
        (self.changed)();
    }
}

impl Sessions {
    fn open(&mut self, key: &str, client: Option<String>) -> Result<String, String> {
        let id = random_hex()?;
        if self.by_id.len() >= MAX_SESSIONS
            && let Some(idle) = self.by_id.iter().min_by_key(|(_, session)| session.used).map(|(id, _)| id.clone())
        {
            self.by_id.remove(&idle);
        }
        self.clock += 1;
        let now = now_ms();
        let session = Session { key: key.to_string(), used: self.clock, opened: self.clock, client, started_ms: now, last_ms: now };
        self.by_id.insert(id.clone(), session);
        Ok(id)
    }

    /// Whether `id` is a live session opened with this token; another token's session is as unknown as a made-up id.
    fn holds(&mut self, id: &str, key: &str) -> bool {
        self.clock += 1;
        match self.by_id.get_mut(id) {
            Some(session) if session.key == key => {
                session.used = self.clock;
                session.last_ms = now_ms();
                true
            }
            _ => false,
        }
    }

    fn close(&mut self, id: &str, key: &str) -> bool {
        self.by_id.get(id).is_some_and(|session| session.key == key) && self.by_id.remove(id).is_some()
    }
}

impl McpState {
    /// Runs a tool call, then tells the app what may have changed: after a failure too, since one can stop halfway,
    /// and a reload that finds nothing new costs little.
    async fn call(&self, role: Role, op: Op, registration: &str, tool: &str) -> Result<Out, String> {
        let role = permit(role, &op).inspect_err(|_| self.activity.record(registration, tool, Outcome::Refused))?;
        let effects = op.effects();
        let outcome = ops::run(&Ctx { store: self.store.clone(), providers: self.providers.clone(), role }, op).await;
        if effects != Effects::default() {
            (self.on_applied)(&effects);
        }
        self.activity.record(registration, tool, outcome.as_ref().map_or(Outcome::Failed, |_| Outcome::Succeeded));
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
    use serde_json::{Value, json};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tower::ServiceExt;

    struct Fixture {
        app: Router,
        store: Arc<Store>,
        applied: Arc<Mutex<Vec<Option<i64>>>>,
        activity: Arc<Activity>,
        changes: Arc<AtomicUsize>,
    }

    fn fixture() -> Fixture {
        fixture_with(crate::ops::tests::ctx())
    }

    fn fixture_with(Ctx { store, providers, .. }: Ctx) -> Fixture {
        let applied = Arc::new(Mutex::new(Vec::new()));
        let log = applied.clone();
        let changes = Arc::new(AtomicUsize::new(0));
        let counted = changes.clone();
        let activity = Activity::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
        });
        let app = router(store.clone(), providers, Arc::new(move |e: &Effects| log.lock().unwrap().push(e.article)), activity.clone());
        Fixture { app, store, applied, activity, changes }
    }

    impl Fixture {
        fn register(&self, name: &str, role: Role) -> Registration {
            mcp::edit(&self.store, &Edit::Create { name: name.into(), role, scope: Scope::Local }).unwrap();
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
            add_command("t0k", Scope::User),
            r#"claude mcp add --transport http --scope user lattice http://127.0.0.1:8788/mcp --header "Authorization: Bearer t0k""#
        );
        assert_eq!(
            add_command("t0k", Scope::Local),
            r#"claude mcp add --transport http --scope local lattice http://127.0.0.1:8788/mcp --header "Authorization: Bearer t0k""#
        );
        assert_eq!(remove_command(Scope::User), "claude mcp remove lattice -s user");
        assert_eq!(remove_command(Scope::Local), "claude mcp remove lattice -s local");
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
        let anonymous = f.send("POST", None, None, &[("origin", "http://127.0.0.1:8788")], init.clone()).await;
        assert_eq!(anonymous.status(), StatusCode::FORBIDDEN, "before the token is looked at");
        let rebound = f.send("POST", Some(&r.token), None, &[("host", "evil.example:8788")], init.clone()).await;
        assert_eq!(rebound.status(), StatusCode::FORBIDDEN, "a page's own name pointed at this PC, with no Origin sent");
        for host in [format!("127.0.0.1:{}", ADDR.port()), format!("LocalHost:{}", ADDR.port())] {
            assert_eq!(f.send("POST", Some(&r.token), None, &[("host", &host)], init.clone()).await.status(), StatusCode::OK, "{host}");
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
        let refused = f.call(&r.token, &session, "tag", json!({ "id": id, "name": "later" })).await;
        assert_eq!(refused["isError"], true);
        assert!(refused["content"][0]["text"].as_str().unwrap().contains("Settings › AI agents (MCP)"), "where the user changes it: {refused}");
        assert!(f.applied.lock().unwrap().is_empty(), "a refused call changes nothing to show");

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
            assert!(refused["content"][0]["text"].as_str().unwrap().ends_with(NO_DELETING), "{name}: {refused}");
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
        let failed = f.call(&r.token, &session, "tag", json!({ "id": id + 1000, "name": "later" })).await;
        assert_eq!(failed["isError"], true, "no such article");
        assert_eq!(*f.applied.lock().unwrap(), [Some(id), Some(id + 1000)], "told after a failure too: one can stop halfway");
    }

    #[tokio::test]
    async fn a_call_runs_to_the_end_and_tells_the_app_when_the_agent_hangs_up() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://localhost:{}/late", listener.local_addr().unwrap().port());
        let page = axum::Router::new().route(
            "/late",
            axum::routing::get(|| async {
                tokio::time::sleep(std::time::Duration::from_millis(600)).await;
                (
                    [(header::CONTENT_TYPE, "text/html")],
                    "<html><head><title>Late</title></head><body><p>It came late, but it came in the end.</p></body></html>",
                )
            }),
        );
        tokio::spawn(async move { axum::serve(listener, page).await });
        let mut ctx = crate::ops::tests::ctx();
        let local = lattice_core::network::NetworkSettings { allow: vec!["localhost".into()], ..Default::default() };
        Arc::get_mut(&mut ctx.providers).unwrap().http = lattice_core::fetch::HttpClient::configured(&local).unwrap();
        let f = fixture_with(ctx);
        let agent = f.register("agent", Role::Edit);
        let session = f.initialize(&agent.token).await;
        let call = f.call(&agent.token, &session, "save", json!({ "url": url, "run": true }));
        assert!(tokio::time::timeout(std::time::Duration::from_millis(200), call).await.is_err(), "the page has not answered yet");
        for _ in 0..50 {
            if !f.applied.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert_eq!(*f.applied.lock().unwrap(), [Some(0)], "the app hears of the save");
        let articles = f.store.list_articles_sorted(&ArticleFilter::All, ArticleSort::SavedDesc).unwrap();
        assert_eq!(articles[0].fetch_status, "ok", "the fetch ran to the end rather than staying claimed until the app quits");
    }

    #[tokio::test]
    async fn each_registration_shows_its_own_sessions_until_its_token_changes() {
        let f = fixture();
        let (a, b) = (f.register("A", Role::Read), f.register("B", Role::Read));
        let hello =
            |info: Value| json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": { "protocolVersion": "2025-11-25", "clientInfo": info } });
        let r = f.post(&a.token, None, hello(json!({ "name": "claude-code", "version": "2.1.327" }))).await;
        let first = r.headers()[SESSION].to_str().unwrap().to_string();
        let r = f.post(&a.token, None, hello(json!({ "name": "x".repeat(200), "version": "" }))).await;
        let second = r.headers()[SESSION].to_str().unwrap().to_string();
        f.initialize(&b.token).await;

        let (sessions, calls) = f.activity.of(&a);
        let clients: Vec<Option<String>> = sessions.iter().map(|s| s.client.clone()).collect();
        assert_eq!(clients, [Some("claude-code 2.1.327".to_string()), Some("x".repeat(MAX_NAME_CHARS))], "oldest first, cut short");
        assert!(calls.is_empty());
        let clients: Vec<Option<String>> = f.activity.of(&b).0.into_iter().map(|s| s.client).collect();
        assert_eq!(clients, [None], "an agent that gave no clientInfo");

        let opened = sessions[0].clone();
        assert!(opened.started_ms > 0 && opened.last_ms == opened.started_ms);
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        assert_eq!(f.post(&a.token, Some(&first), json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" })).await.status(), StatusCode::OK);
        let used = f.activity.of(&a).0[0].clone();
        assert!(used.started_ms == opened.started_ms && used.last_ms > opened.last_ms, "its last request: {used:?}");

        assert_eq!(f.send("DELETE", Some(&a.token), Some(&second), &[], Value::Null).await.status(), StatusCode::NO_CONTENT);
        assert_eq!(f.activity.of(&a).0.len(), 1, "ended by the agent");
        mcp::edit(&f.store, &Edit::Regenerate { id: a.id.clone() }).unwrap();
        assert!(f.activity.of(&f.reread("A")).0.is_empty(), "the old token's sessions answer no more, so they go from the screen");
        assert_eq!(f.activity.of(&b).0.len(), 1);
    }

    #[tokio::test]
    async fn each_call_shows_how_it_ended_newest_first_and_only_the_latest_are_kept() {
        let f = fixture();
        let (reader, editor) = (f.register("reader", Role::Read), f.register("editor", Role::Edit));
        let id = f.saved("https://example.com/a");
        let (rs, es) = (f.initialize(&reader.token).await, f.initialize(&editor.token).await);
        f.call(&editor.token, &es, "get", json!({ "id": id })).await;
        f.call(&editor.token, &es, "tag", json!({ "id": id + 1000, "name": "later" })).await;
        f.call(&editor.token, &es, "rename_article", json!({ "id": id, "name": "Typo" })).await;
        let unknown = format!("drop_{}", "x".repeat(100));
        let r = f.post(&editor.token, Some(&es), json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": unknown } })).await;
        assert_eq!(r.status(), StatusCode::OK);
        f.call(&editor.token, &es, "delete_article", json!({ "id": id })).await;
        f.call(&reader.token, &rs, "tag", json!({ "id": id, "name": "later" })).await;
        let notification = json!({ "jsonrpc": "2.0", "method": "tools/call", "params": { "name": "get", "arguments": { "id": id } } });
        assert_eq!(f.post(&editor.token, Some(&es), notification).await.status(), StatusCode::ACCEPTED);

        let seen = |r: &Registration| -> Vec<(String, Outcome)> { f.activity.of(r).1.into_iter().map(|c| (c.tool, c.outcome)).collect() };
        let cut: String = unknown.chars().take(MAX_NAME_CHARS).collect();
        let expected = [
            ("delete_article", Outcome::Refused),
            (cut.as_str(), Outcome::Failed),
            ("rename_article", Outcome::Failed),
            ("tag", Outcome::Failed),
            ("get", Outcome::Succeeded),
        ];
        assert_eq!(seen(&editor), expected.map(|(tool, outcome)| (tool.to_string(), outcome)), "a deletion, an unknown tool, bad arguments, a tool error");
        assert_eq!(seen(&reader), [("tag".to_string(), Outcome::Refused)], "above the role");

        for _ in 0..MAX_CALLS - 2 {
            f.call(&editor.token, &es, "get", json!({ "id": id })).await;
        }
        let calls = f.activity.of(&editor).1;
        assert_eq!(calls.len(), MAX_CALLS);
        let oldest: Vec<&str> = calls[MAX_CALLS - 2..].iter().map(|c| c.tool.as_str()).collect();
        assert_eq!(oldest, ["delete_article", cut.as_str()], "the three oldest made room");
        assert!(calls.windows(2).all(|w| w[0].at_ms >= w[1].at_ms));
    }

    #[tokio::test]
    async fn the_screen_hears_of_each_change_and_nothing_else() {
        let f = fixture();
        let r = f.register("A", Role::Read);
        let id = f.saved("https://example.com/a");
        let changes = || f.changes.load(Ordering::SeqCst);
        let ping = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" });
        let mut last = changes();
        let mut changed = |why: &str| {
            let now = changes();
            assert!(now > last, "{why}");
            last = now;
        };

        let session = f.initialize(&r.token).await;
        changed("a session opened");
        f.post(&r.token, Some(&session), ping.clone()).await;
        changed("its last request");
        f.call(&r.token, &session, "get", json!({ "id": id })).await;
        changed("a call");
        f.send("DELETE", Some(&r.token), Some(&session), &[], Value::Null).await;
        changed("the session ended");

        let before = changes();
        assert_eq!(f.post("wrong", Some(&session), ping.clone()).await.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(f.post(&r.token, Some(&session), ping).await.status(), StatusCode::NOT_FOUND);
        assert_eq!(f.send("DELETE", Some(&r.token), Some(&session), &[], Value::Null).await.status(), StatusCode::NOT_FOUND);
        assert_eq!(changes(), before, "refused before reaching a session");
    }

    #[test]
    fn the_session_idle_longest_makes_room() {
        let mut s = Sessions::default();
        let first = s.open("k", None).unwrap();
        let rest: Vec<String> = (1..MAX_SESSIONS).map(|_| s.open("k", None).unwrap()).collect();
        assert!(s.holds(&first, "k"), "used again, so no longer the idlest");
        let newest = s.open("k", None).unwrap();
        assert_eq!(s.by_id.len(), MAX_SESSIONS);
        assert!(s.holds(&first, "k") && s.holds(&newest, "k"));
        assert!(!s.holds(&rest[0], "k"), "the one idle longest went");
    }
}
