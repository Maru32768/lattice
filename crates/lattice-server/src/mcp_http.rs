//! MCP over Streamable HTTP for the app: one endpoint on this PC's loopback, a bearer token per registration, and the
//! registration read again at every request, so a new token, a new role and a deletion hold from the next one. The
//! JSON-RPC itself is `mcp::step`, shared with `lattice-cli mcp`.

use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use futures_util::stream;
use lattice_core::chain::LlmChain;
use lattice_core::embed::LocalE5;
use lattice_core::jobs::Providers;
use lattice_core::mcp::{self, Registration, Role, Scope};
use lattice_core::mobile::{Effects, blocking};
use lattice_core::store::{Store, random_hex, sha256_hex};
use serde::Serialize;
use tokio::sync::oneshot;
use ts_rs::TS;

use crate::mcp::{Message, PROTOCOL_VERSIONS, Step, step, tool_reply};
use crate::ops::{self, Ctx, Deletion, Op, Out};
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
/// How long a deletion waits for the user's answer before it is refused.
const APPROVAL_WAIT: Duration = Duration::from_secs(120);
/// Deletions waiting at once: an agent asking again and again is refused at once past it, rather than queueing a dialog
/// for each.
const MAX_WAITING: usize = 10;
const READ_ONLY: &str = "This tool changes the library, and this connection may only read it. The user can change that in Lattice: Settings › AI agents (MCP).";
const MAY_NOT_DELETE: &str =
    "This tool deletes from the library, and this connection may not delete. The user can change that in Lattice: Settings › AI agents (MCP).";
const DENIED: &str = "The user did not allow this deletion in Lattice. Nothing was deleted.";
const UNANSWERED: &str = "Nobody answered in Lattice within 2 minutes, so nothing was deleted.";
const STOPPED: &str = "The MCP server stopped before the user answered in Lattice. Nothing was deleted.";
const TOO_MANY: &str = "Too many deletions are waiting for the user's answer in Lattice. Nothing was deleted: ask again once they are answered.";
const CHANGED: &str = "What this would delete changed while the user decided in Lattice. Nothing was deleted: look it up again.";

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
    approvals: Arc<Approvals>,
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
    /// Above the registration's role, or a deletion the user did not allow.
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
    info: SessionInfo,
}

/// `/mcp` for the registrations in `store`. Writes report what they changed through `on_applied`, as the phone's do;
/// sessions and calls go to `activity`, and deletions wait in `approvals` for the user.
pub fn router(
    store: Arc<Store>,
    providers: Arc<Providers<LlmChain, LocalE5>>,
    on_applied: OnApplied,
    activity: Arc<Activity>,
    approvals: Arc<Approvals>,
) -> Router {
    // GET (a stream from the server) and every other method get 405 from the method router.
    Router::new().route(ENDPOINT, post(post_message).delete(end_session)).layer(middleware::from_fn(refuse_browsers)).with_state(McpState {
        store,
        providers,
        on_applied,
        activity,
        approvals,
    })
}

/// Deletions waiting for the user's answer in the app, oldest first. Memory only, and made anew with each server, like
/// `Activity`.
pub struct Approvals {
    waiting: Mutex<Waiting>,
    wait: Duration,
    changed: Box<dyn Fn(bool) + Send + Sync>,
}

#[derive(Default)]
struct Waiting {
    asks: Vec<(Approval, oneshot::Sender<bool>)>,
    next: u64,
    /// The server is stopping: what waits is refused, and nothing more is asked.
    closed: bool,
}

/// A deletion as the app asks the user about it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, rename = "McpApproval")]
pub struct Approval {
    pub id: u64,
    /// The registration asking, by the name the user gave it.
    pub registration: String,
    pub deletion: Deletion,
    /// When it is refused unanswered.
    pub deadline_ms: u64,
}

/// What a call may run with: the role, and for a deletion, what the user allowed.
struct Permit {
    role: Role,
    allowed: Option<Deletion>,
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

/// Whether the client takes a reply as a stream of events, as the spec has every client say.
fn takes_events(headers: &HeaderMap) -> bool {
    headers.get_all(header::ACCEPT).iter().any(|v| v.to_str().is_ok_and(|v| v.contains("text/event-stream")))
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
            let tool = tool.unwrap_or_default();
            let reply = async move {
                let outcome = match st.permit(&registration, &op, &tool).await {
                    Ok(permit) => {
                        // Its own task: an agent that hangs up mid-call would otherwise drop the operation halfway,
                        // leaving a job it claimed claimed until the app quits, and the app never told what was written.
                        let (st, who) = (st.clone(), registration.id);
                        tokio::spawn(async move { st.call(permit, op, &who, &tool).await }).await.unwrap_or_else(|e| Err(e.to_string()))
                    }
                    Err(e) => Err(e),
                };
                tool_reply(id, outcome)
            };
            if takes_events(&headers) {
                // Claude Code gives up on a reply whose headers take 60 s, and a deletion waits up to two minutes for
                // the user, an `ask` for the LLM: the headers go at once, and the reply follows as an event.
                let event = stream::once(async move { Ok::<_, Infallible>(Event::default().event("message").data(reply.await.to_string())) });
                return Sse::new(event).keep_alive(KeepAlive::default()).into_response();
            }
            reply.await
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
            held.into_iter().map(|s| s.info.clone()).collect()
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

impl Approvals {
    /// `changed(true)` runs when a deletion starts waiting and `changed(false)` when one stops, with no lock held.
    pub fn new(changed: impl Fn(bool) + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self { waiting: Mutex::default(), wait: APPROVAL_WAIT, changed: Box::new(changed) })
    }

    /// Oldest first.
    pub fn waiting(&self) -> Vec<Approval> {
        lock(&self.waiting).asks.iter().map(|(approval, _)| approval.clone()).collect()
    }

    /// The user's answer. One to a deletion no longer waiting comes too late and changes nothing.
    pub fn answer(&self, id: u64, allow: bool) {
        if let Some(reply) = self.take(id) {
            let _ = reply.send(allow);
        }
    }

    /// Refuses what waits and all that is asked from here on: the calls of a stopped server can outlive it, and nothing
    /// would show what they wait for.
    pub fn close(&self) {
        let refused = {
            let mut waiting = lock(&self.waiting);
            waiting.closed = true;
            std::mem::take(&mut waiting.asks)
        };
        if !refused.is_empty() {
            (self.changed)(false);
        }
    }

    /// Waits for the user to allow `deletion`, in the caller's task: once that is dropped, as when the agent hangs up,
    /// it waits no more.
    async fn ask(&self, registration: &str, deletion: Deletion) -> Result<(), &'static str> {
        let (reply, answer) = oneshot::channel();
        let id = {
            let mut waiting = lock(&self.waiting);
            if waiting.closed {
                return Err(STOPPED);
            }
            if waiting.asks.len() >= MAX_WAITING {
                return Err(TOO_MANY);
            }
            waiting.next += 1;
            let (id, deadline_ms) = (waiting.next, now_ms() + self.wait.as_millis() as u64);
            waiting.asks.push((Approval { id, registration: registration.to_string(), deletion, deadline_ms }, reply));
            id
        };
        (self.changed)(true);
        let _withdraw = Withdraw(self, id);
        match tokio::time::timeout(self.wait, answer).await {
            Ok(Ok(true)) => Ok(()),
            Ok(Ok(false)) => Err(DENIED),
            Ok(Err(_)) => Err(STOPPED),
            Err(_) => Err(UNANSWERED),
        }
    }

    fn take(&self, id: u64) -> Option<oneshot::Sender<bool>> {
        let reply = {
            let mut waiting = lock(&self.waiting);
            let at = waiting.asks.iter().position(|(approval, _)| approval.id == id)?;
            waiting.asks.remove(at).1
        };
        (self.changed)(false);
        Some(reply)
    }
}

/// Takes a deletion off the screen once it stops waiting, however that happens.
struct Withdraw<'a>(&'a Approvals, u64);

impl Drop for Withdraw<'_> {
    fn drop(&mut self) {
        self.0.take(self.1);
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
        let session = Session { key: key.to_string(), used: self.clock, opened: self.clock, info: SessionInfo { client, started_ms: now, last_ms: now } };
        self.by_id.insert(id.clone(), session);
        Ok(id)
    }

    /// Whether `id` is a live session opened with this token; another token's session is as unknown as a made-up id.
    fn holds(&mut self, id: &str, key: &str) -> bool {
        self.clock += 1;
        match self.by_id.get_mut(id) {
            Some(session) if session.key == key => {
                session.used = self.clock;
                session.info.last_ms = now_ms();
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
    /// Whether a call may run, in words an agent can pass on if not. A deletion waits for the user here, in the request's
    /// own task, so an agent that hangs up meanwhile takes its request off the screen.
    async fn permit(&self, registration: &Registration, op: &Op, tool: &str) -> Result<Permit, String> {
        let stop = |why: &str, outcome| {
            self.activity.record(&registration.id, tool, outcome);
            Err(why.to_string())
        };
        match (op.role(), registration.role) {
            (Role::Edit, Role::Read) => stop(READ_ONLY, Outcome::Refused),
            (Role::Delete, Role::Read | Role::Edit) => stop(MAY_NOT_DELETE, Outcome::Refused),
            // Below deletion, for `ops::run` to check again.
            (Role::Read | Role::Edit, role) => Ok(Permit { role: role.min(Role::Edit), allowed: None }),
            (Role::Delete, Role::Delete) => {
                let shown = match op.deletion(&self.store) {
                    Ok(shown) => shown,
                    Err(e) => return stop(&e, Outcome::Failed),
                };
                match self.approvals.ask(&registration.name, shown.clone()).await {
                    Ok(()) => Ok(Permit { role: Role::Delete, allowed: Some(shown) }),
                    Err(why) => stop(why, Outcome::Refused),
                }
            }
        }
    }

    /// Runs a tool call, then tells the app what may have changed: after a failure too, since one can stop halfway,
    /// and a reload that finds nothing new costs little.
    async fn call(&self, permit: Permit, op: Op, registration: &str, tool: &str) -> Result<Out, String> {
        if let Some(allowed) = permit.allowed
            && !op.deletion(&self.store).is_ok_and(|now| now.same_target(&allowed))
        {
            self.activity.record(registration, tool, Outcome::Failed);
            return Err(CHANGED.into());
        }
        let effects = op.effects();
        let outcome = ops::run(&Ctx { store: self.store.clone(), providers: self.providers.clone(), role: permit.role }, op).await;
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
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{OnceLock, Weak};
    use tower::ServiceExt;

    #[derive(Clone)]
    struct Fixture {
        app: Router,
        store: Arc<Store>,
        applied: Arc<Mutex<Vec<Option<i64>>>>,
        activity: Arc<Activity>,
        changes: Arc<AtomicUsize>,
        /// Set when `changed` ran with a lock of the activity or the approvals held.
        locked: Arc<AtomicBool>,
        approvals: Arc<Approvals>,
        /// What each `changed` of the approvals said: whether a deletion started waiting.
        signals: Arc<Mutex<Vec<bool>>>,
    }

    fn fixture() -> Fixture {
        fixture_with(crate::ops::tests::ctx(), APPROVAL_WAIT)
    }

    fn fixture_with(Ctx { store, providers, .. }: Ctx, wait: Duration) -> Fixture {
        let applied = Arc::new(Mutex::new(Vec::new()));
        let log = applied.clone();
        let changes = Arc::new(AtomicUsize::new(0));
        let locked = Arc::new(AtomicBool::new(false));
        let me: Arc<OnceLock<Weak<Activity>>> = Arc::default();
        let (counted, seen, this) = (changes.clone(), locked.clone(), me.clone());
        let activity = Activity::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
            if let Some(a) = this.get().and_then(Weak::upgrade)
                && (a.sessions.try_lock().is_err() || a.calls.try_lock().is_err())
            {
                seen.store(true, Ordering::SeqCst);
            }
        });
        me.set(Arc::downgrade(&activity)).ok();
        let signals = Arc::new(Mutex::new(Vec::new()));
        let asked: Arc<OnceLock<Weak<Approvals>>> = Arc::default();
        let (said, seen, this) = (signals.clone(), locked.clone(), asked.clone());
        let changed = move |arrived| {
            said.lock().unwrap().push(arrived);
            if this.get().and_then(Weak::upgrade).is_some_and(|a| a.waiting.try_lock().is_err()) {
                seen.store(true, Ordering::SeqCst);
            }
        };
        let approvals = Arc::new(Approvals { waiting: Mutex::default(), wait, changed: Box::new(changed) });
        asked.set(Arc::downgrade(&approvals)).ok();
        let on_applied = Arc::new(move |e: &Effects| log.lock().unwrap().push(e.article));
        let app = router(store.clone(), providers, on_applied, activity.clone(), approvals.clone());
        Fixture { app, store, applied, activity, changes, locked, approvals, signals }
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

        /// A tool call that goes on while the test answers for the user.
        fn call_later(&self, token: &str, session: &str, name: &str, arguments: Value) -> tokio::task::JoinHandle<Value> {
            let (f, token, session, name) = (self.clone(), token.to_string(), session.to_string(), name.to_string());
            tokio::spawn(async move { f.call(&token, &session, &name, arguments).await })
        }

        /// Once `n` deletions wait for the user.
        async fn asked(&self, n: usize) -> Vec<Approval> {
            for _ in 0..250 {
                let waiting = self.approvals.waiting();
                if waiting.len() == n {
                    return waiting;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            panic!("{} deletions wait, not {n}", self.approvals.waiting().len());
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

    fn says(result: &Value, why: &str) -> bool {
        result["isError"] == true && result["content"][0]["text"].as_str().is_some_and(|text| text.ends_with(why))
    }

    #[tokio::test]
    async fn each_role_lists_its_tools_and_only_the_delete_role_gets_asked() {
        let f = fixture();
        let id = f.saved("https://example.com/a");
        let mut counts = Vec::new();
        for (name, role) in [("read", Role::Read), ("edit", Role::Edit), ("delete", Role::Delete)] {
            let r = f.register(name, role);
            let session = f.initialize(&r.token).await;
            counts.push(f.tool_count(&r.token, &session).await);
            if role < Role::Delete {
                let refused = f.call(&r.token, &session, "delete_article", json!({ "id": id })).await;
                assert!(says(&refused, MAY_NOT_DELETE), "{name}: {refused}");
                assert_eq!(f.activity.of(&r).1[0].outcome, Outcome::Refused);
            }
        }
        assert_eq!(counts, [10, 30, 35]);
        assert!(f.signals.lock().unwrap().is_empty(), "the user was not asked");
        assert_eq!(f.titles().len(), 1, "nothing was deleted");
        assert!(f.applied.lock().unwrap().is_empty(), "a refused call changes nothing to show");
    }

    #[tokio::test]
    async fn a_deletion_runs_once_the_user_allows_it() {
        let f = fixture();
        let r = f.register("Claude Code", Role::Delete);
        let id = f.saved("https://example.com/a");
        let session = f.initialize(&r.token).await;
        let before = now_ms();
        let call = f.call_later(&r.token, &session, "delete_article", json!({ "id": id }));
        let asked = f.asked(1).await;
        let article = Deletion::Article { title: None, url: "https://example.com/a".into() };
        assert_eq!((asked[0].registration.as_str(), &asked[0].deletion), ("Claude Code", &article), "read from the library");
        let wait = APPROVAL_WAIT.as_millis() as u64;
        assert!((before + wait..=now_ms() + wait).contains(&asked[0].deadline_ms), "two minutes from when it was asked");
        assert!(f.titles().len() == 1 && f.applied.lock().unwrap().is_empty(), "nothing deleted before the answer");

        f.approvals.answer(asked[0].id, true);
        let done = call.await.unwrap();
        assert_eq!(done["isError"], false, "{done}");
        assert!(f.titles().is_empty());
        assert_eq!(*f.applied.lock().unwrap(), [Some(id)]);
        assert!(f.approvals.waiting().is_empty());
        assert_eq!(*f.signals.lock().unwrap(), [true, false], "the app hears when it starts waiting and when it stops");
        assert_eq!(f.activity.of(&r).1[0].outcome, Outcome::Succeeded);
        assert!(!f.locked.load(Ordering::SeqCst), "changed ran with a lock held, so reading the approvals from it would deadlock");
    }

    #[tokio::test]
    async fn a_deletion_the_user_denies_or_leaves_unanswered_deletes_nothing() {
        let f = fixture_with(crate::ops::tests::ctx(), Duration::from_millis(300));
        let r = f.register("agent", Role::Delete);
        let id = f.saved("https://example.com/a");
        let session = f.initialize(&r.token).await;
        let call = f.call_later(&r.token, &session, "delete_article", json!({ "id": id }));
        let asked = f.asked(1).await;
        f.approvals.answer(asked[0].id, false);
        let denied = call.await.unwrap();
        assert!(says(&denied, DENIED), "{denied}");
        f.approvals.answer(asked[0].id, true);

        let unanswered = f.call(&r.token, &session, "delete_article", json!({ "id": id })).await;
        assert!(says(&unanswered, UNANSWERED), "{unanswered}");
        assert!(f.approvals.waiting().is_empty(), "off the screen");
        assert_eq!(f.titles().len(), 1, "an answer that came too late changed nothing either");
        assert!(f.applied.lock().unwrap().is_empty());
        let outcomes: Vec<Outcome> = f.activity.of(&r).1.into_iter().map(|c| c.outcome).collect();
        assert_eq!(outcomes, [Outcome::Refused, Outcome::Refused]);
    }

    #[tokio::test]
    async fn a_deletion_of_nothing_fails_without_asking() {
        let f = fixture();
        let r = f.register("agent", Role::Delete);
        let session = f.initialize(&r.token).await;
        let missing = [
            ("delete_article", json!({ "id": 999 })),
            ("delete_collection", json!({ "id": 999 })),
            ("remove_feed", json!({ "id": 999 })),
            ("delete_folder", json!({ "id": 999 })),
            ("merge_genre", json!({ "from": "Nope", "into": "Ghost" })),
        ];
        for (tool, arguments) in missing {
            assert_eq!(f.call(&r.token, &session, tool, arguments).await["isError"], true, "{tool}");
        }
        assert!(f.signals.lock().unwrap().is_empty(), "the user was not asked");
        assert!(f.activity.of(&r).1.iter().all(|c| c.outcome == Outcome::Failed));
    }

    #[tokio::test]
    async fn deletions_wait_oldest_first_up_to_a_limit_and_stop_with_the_server() {
        let f = fixture();
        let r = f.register("agent", Role::Delete);
        let (a, b) = (f.saved("https://example.com/a"), f.saved("https://example.com/b"));
        let session = f.initialize(&r.token).await;
        let mut calls = vec![f.call_later(&r.token, &session, "delete_article", json!({ "id": a }))];
        f.asked(1).await;
        tokio::time::sleep(Duration::from_millis(5)).await;
        calls.push(f.call_later(&r.token, &session, "delete_article", json!({ "id": b })));
        let asked = f.asked(2).await;
        let urls: Vec<&Deletion> = asked.iter().map(|a| &a.deletion).collect();
        let article = |url: &str| Deletion::Article { title: None, url: url.into() };
        assert_eq!(urls, [&article("https://example.com/a"), &article("https://example.com/b")], "oldest first");
        assert!(asked[0].deadline_ms < asked[1].deadline_ms, "each waits its own two minutes");

        calls.extend((2..MAX_WAITING).map(|_| f.call_later(&r.token, &session, "delete_article", json!({ "id": a }))));
        f.asked(MAX_WAITING).await;
        let refused = f.call(&r.token, &session, "delete_article", json!({ "id": a })).await;
        assert!(says(&refused, TOO_MANY), "{refused}");
        assert_eq!(f.approvals.waiting().len(), MAX_WAITING, "not asked");

        f.approvals.close();
        for call in calls {
            let stopped = call.await.unwrap();
            assert!(says(&stopped, STOPPED), "{stopped}");
        }
        assert!(f.approvals.waiting().is_empty());
        let after = f.call(&r.token, &session, "delete_article", json!({ "id": a })).await;
        assert!(says(&after, STOPPED), "a stopped server asks no more: {after}");
        assert_eq!(f.titles().len(), 2);
    }

    #[tokio::test]
    async fn a_client_that_takes_events_gets_the_headers_at_once_and_the_reply_once_it_is_ready() {
        let f = fixture();
        let r = f.register("agent", Role::Delete);
        let (a, b) = (f.saved("https://example.com/a"), f.saved("https://example.com/b"));
        let session = f.initialize(&r.token).await;
        let events = [(header::ACCEPT.as_str(), "application/json, text/event-stream")];
        let delete = |id: i64| json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": "delete_article", "arguments": { "id": id } } });
        // As a server does: the body is read from the moment the headers are sent.
        let read =
            |r: Response| tokio::spawn(async move { String::from_utf8(axum::body::to_bytes(r.into_body(), usize::MAX).await.unwrap().to_vec()).unwrap() });

        let started = f.send("POST", Some(&r.token), Some(&session), &events, delete(a)).await;
        assert_eq!(started.status(), StatusCode::OK);
        assert_eq!(started.headers()[header::CONTENT_TYPE], "text/event-stream", "before the user has answered");
        let body = read(started);
        f.approvals.answer(f.asked(1).await[0].id, true);
        let body = body.await.unwrap();
        let reply: Value = serde_json::from_str(body.lines().find_map(|line| line.strip_prefix("data: ")).unwrap()).unwrap();
        assert!(body.starts_with("event: message\n"), "{body}");
        assert_eq!((reply["id"].as_i64(), reply["result"]["isError"].as_bool()), (Some(7), Some(false)), "{reply}");
        assert_eq!(f.titles().len(), 1);

        let hung_up = read(f.send("POST", Some(&r.token), Some(&session), &events, delete(b)).await);
        f.asked(1).await;
        hung_up.abort();
        assert!(hung_up.await.unwrap_err().is_cancelled());
        assert!(f.approvals.waiting().is_empty(), "an agent that stops reading takes its request off the screen");
        assert_eq!(f.titles().len(), 1);
    }

    #[tokio::test]
    async fn an_agent_that_hangs_up_takes_its_deletion_off_the_screen() {
        let f = fixture();
        let r = f.register("agent", Role::Delete);
        let id = f.saved("https://example.com/a");
        let session = f.initialize(&r.token).await;
        let call = f.call(&r.token, &session, "delete_article", json!({ "id": id }));
        assert!(tokio::time::timeout(Duration::from_millis(200), call).await.is_err(), "still waiting for the user");
        assert!(f.approvals.waiting().is_empty());
        assert_eq!(*f.signals.lock().unwrap(), [true, false]);
        assert_eq!(f.titles().len(), 1);
    }

    #[tokio::test]
    async fn what_changed_while_the_user_decided_is_not_deleted() {
        let f = fixture();
        let r = f.register("agent", Role::Delete);
        f.saved("https://example.com/first");
        let id = f.saved("https://example.com/a");
        let session = f.initialize(&r.token).await;
        let call = f.call_later(&r.token, &session, "delete_article", json!({ "id": id }));
        let asked = f.asked(1).await;
        f.store.delete_article(id).unwrap();
        assert_eq!(f.saved("https://example.com/b"), id, "the id came back on another article");
        f.approvals.answer(asked[0].id, true);
        let changed = call.await.unwrap();
        assert!(says(&changed, CHANGED), "{changed}");
        assert_eq!(f.titles().len(), 2, "the article saved since stays");
        assert_eq!(f.activity.of(&r).1[0].outcome, Outcome::Failed);
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
        let f = fixture_with(ctx, APPROVAL_WAIT);
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
        f.call(&a.token, &first, "list", json!({})).await;
        mcp::edit(&f.store, &Edit::Regenerate { id: a.id.clone() }).unwrap();
        let (sessions, calls) = f.activity.of(&f.reread("A"));
        assert!(sessions.is_empty(), "the old token's sessions answer no more, so they go from the screen");
        assert_eq!(calls.len(), 1, "what the agent did stays");
        assert_eq!(f.activity.of(&b).0.len(), 1);
    }

    #[tokio::test]
    async fn each_call_shows_how_it_ended_newest_first_and_only_the_latest_are_kept() {
        assert_eq!(MAX_CALLS, 20, "the settings screen says the latest 20");
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
        let before_call = changes();
        f.call(&r.token, &session, "get", json!({ "id": id })).await;
        assert_eq!(changes(), before_call + 2, "its request, then how it ended: a slow call's outcome does not wait for the next request");
        changed("a call");
        f.send("DELETE", Some(&r.token), Some(&session), &[], Value::Null).await;
        changed("the session ended");

        let before = changes();
        let init = json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize" });
        assert_eq!(f.post("wrong", None, init.clone()).await.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(f.send("POST", Some(&r.token), None, &[("origin", "http://127.0.0.1:8788")], init).await.status(), StatusCode::FORBIDDEN);
        assert_eq!(f.post(&r.token, Some(&session), ping).await.status(), StatusCode::NOT_FOUND);
        assert_eq!(f.send("DELETE", Some(&r.token), Some(&session), &[], Value::Null).await.status(), StatusCode::NOT_FOUND);
        assert_eq!(changes(), before, "refused before reaching a session");
        assert!(!f.locked.load(Ordering::SeqCst), "changed ran with a lock held, so reading the activity from it would deadlock");
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
