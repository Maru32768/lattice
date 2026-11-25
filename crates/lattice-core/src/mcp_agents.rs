//! Puts the app's MCP registrations in the agents' own user settings, and makes the text the settings screen copies where
//! the app does not (design-review §23).
//!
//! Claude Code is written through its CLI and Codex through `codex app-server`, so the format of each settings file, its
//! lock and its backups stay the agent's business. `codex mcp add` takes no literal header, only the name of an
//! environment variable to read the token from, which the app cannot set for the user's shells.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

use crate::mcp::{CLIENT_NAME, Target, registrations, url};
use crate::msg;
use crate::store::Store;

/// One change to an agent's settings at a time, each from the registrations as stored when its turn comes, so the last
/// one written holds the last token.
static WRITING: Mutex<()> = Mutex::const_new(());
/// An error a CLI prints is cut to this before the settings screen shows it.
const MAX_ERROR_CHARS: usize = 400;
/// How long `codex app-server` gets to leave by itself once its change is made.
const LEAVE: Duration = Duration::from_secs(3);

/// What the settings screen copies for a registration.
pub fn copied(target: Target, token: &str) -> String {
    let (url, bearer) = (url(), format!("Bearer {token}"));
    let claude = |scope| format!("claude mcp add --transport http --scope {scope} {CLIENT_NAME} {url} --header \"Authorization: {bearer}\"");
    match target {
        Target::ClaudeCode => claude("user"),
        Target::ClaudeCodeProject => claude("local"),
        Target::Codex => format!("[mcp_servers.{CLIENT_NAME}]\nurl = \"{url}\"\nhttp_headers = {{ Authorization = \"{bearer}\" }}\n"),
        Target::Other => {
            format!("{:#}", json!({ "mcpServers": { CLIENT_NAME: { "type": "http", "url": url, "headers": { "Authorization": bearer } } } }))
        }
    }
}

/// The command that takes a registration out of its agent by hand.
pub fn removal(target: Target) -> Option<String> {
    match target {
        Target::ClaudeCode => Some(format!("claude mcp remove {CLIENT_NAME} -s user")),
        Target::ClaudeCodeProject => Some(format!("claude mcp remove {CLIENT_NAME} -s local")),
        Target::Codex => Some(format!("codex mcp remove {CLIENT_NAME}")),
        Target::Other => None,
    }
}

/// The agents' programs and the settings folders they are run on.
pub struct Agents {
    claude: String,
    codex: String,
    /// `CLAUDE_CONFIG_DIR`; None is the user's home folder.
    claude_dir: Option<PathBuf>,
    /// `CODEX_HOME`; None leaves it to Codex.
    codex_home: Option<PathBuf>,
    /// For one change, however many processes it takes.
    timeout: Duration,
}

impl Default for Agents {
    fn default() -> Self {
        Self {
            claude: "claude".into(),
            codex: "codex".into(),
            claude_dir: std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()).map(PathBuf::from),
            codex_home: None,
            timeout: Duration::from_secs(30),
        }
    }
}

/// What an agent's settings hold under `CLIENT_NAME`.
#[derive(Debug, PartialEq, Eq)]
enum Entry {
    Absent,
    /// For this app's server, with the token it sends.
    Lattices(Option<String>),
    SomeoneElses,
}

/// `headers` is the agent's name for the entry's table of headers.
fn entry(found: &Value, headers: &str) -> Entry {
    if found.is_null() {
        return Entry::Absent;
    }
    if found["url"].as_str() != Some(&url()) {
        return Entry::SomeoneElses;
    }
    let authorization = found[headers].as_object().and_then(|h| h.iter().find(|(name, _)| name.eq_ignore_ascii_case("authorization")));
    Entry::Lattices(authorization.and_then(|(_, value)| value.as_str()?.strip_prefix("Bearer ").map(String::from)))
}

/// What the agent's settings should hold.
#[derive(Clone, Copy)]
enum Want<'a> {
    Token(&'a str),
    /// Nothing, unless one of these tokens, which the registrations that are left have, is the one there.
    Gone {
        left: &'a [String],
    },
}

#[derive(Debug, PartialEq, Eq)]
enum Step<'a> {
    Leave,
    Add(&'a str),
    Replace(&'a str),
    Remove,
}

fn step<'a>(found: &Entry, want: Want<'a>) -> Result<Step<'a>, Failure> {
    Ok(match (want, found) {
        (Want::Token(_), Entry::SomeoneElses) => return Err(Failure::SomeoneElses),
        (Want::Token(token), Entry::Absent) => Step::Add(token),
        (Want::Token(token), Entry::Lattices(_)) => Step::Replace(token),
        (Want::Gone { .. }, Entry::Absent | Entry::SomeoneElses) => Step::Leave,
        (Want::Gone { left }, Entry::Lattices(Some(token))) if left.contains(token) => Step::Leave,
        (Want::Gone { .. }, Entry::Lattices(_)) => Step::Remove,
    })
}

#[derive(Debug)]
enum Failure {
    Missing(String),
    SomeoneElses,
    Failed(String),
}

impl Failure {
    fn failed(e: impl ToString) -> Self {
        Self::Failed(e.to_string())
    }

    fn message(self, agent: &str) -> String {
        match self {
            Self::Missing(program) => msg!("mcp.agentMissing", agent = agent, program = program),
            Self::SomeoneElses => msg!("mcp.agentOther", agent = agent, name = CLIENT_NAME),
            Self::Failed(error) => msg!("mcp.agentFailed", agent = agent, error = scrubbed(&error)),
        }
    }
}

/// A CLI may repeat its arguments or a line of its settings, so any token goes: this registration's, an older one's, or
/// another server's.
fn scrubbed(error: &str) -> String {
    static TOKEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)\bbearer\s+[^\s"'\\]{16,}|[0-9a-f]{64}"#).expect("static regex"));
    let line: Vec<&str> = error.split_whitespace().collect();
    TOKEN.replace_all(&line.join(" "), "***").chars().take(MAX_ERROR_CHARS).collect()
}

impl Agents {
    /// Puts the registration in its agent's settings: true once they hold its token, false where the app does not write
    /// them or the registration is gone.
    pub async fn connect(&self, store: &Store, id: &str) -> Result<bool, String> {
        let _turn = WRITING.lock().await;
        match registrations(store)?.into_iter().find(|r| r.id == id) {
            Some(r) => self.write(r.target, Want::Token(&r.token)).await,
            None => Ok(false),
        }
    }

    /// Takes a deleted registration out of its agent's settings: true once it is out, false where there was nothing of it
    /// to take out.
    pub async fn disconnect(&self, store: &Store, target: Target) -> Result<bool, String> {
        let _turn = WRITING.lock().await;
        let left: Vec<String> = registrations(store)?.into_iter().map(|r| r.token).collect();
        self.write(target, Want::Gone { left: &left }).await
    }

    async fn write(&self, target: Target, want: Want<'_>) -> Result<bool, String> {
        let Some(agent) = target.agent() else {
            return Ok(false);
        };
        let change = async {
            match target {
                Target::ClaudeCode => self.write_claude_code(want).await,
                Target::Codex => self.write_codex(want).await,
                Target::ClaudeCodeProject | Target::Other => Ok(false),
            }
        };
        let timed_out = || Err(Failure::failed(format!("timed out after {:?}", self.timeout)));
        let written = tokio::time::timeout(self.timeout, change).await.unwrap_or_else(|_| timed_out()).map_err(|f| f.message(agent))?;
        if written {
            log::info!(
                "{agent}: the MCP server {CLIENT_NAME} was {}",
                if matches!(want, Want::Token(_)) {
                    "written"
                } else {
                    "removed"
                }
            );
        }
        Ok(written)
    }

    async fn write_claude_code(&self, want: Want<'_>) -> Result<bool, Failure> {
        let found = entry(&self.claude_code_entry()?, "headers");
        let remove = ["mcp", "remove", CLIENT_NAME, "-s", "user"];
        let token = match step(&found, want)? {
            Step::Leave => return Ok(false),
            Step::Remove => return self.claude(&remove).await.map(|()| true),
            Step::Add(token) => token,
            Step::Replace(token) => {
                // `add` refuses a name it already has.
                self.claude(&remove).await?;
                token
            }
        };
        let header = format!("Authorization: Bearer {token}");
        self.claude(&["mcp", "add", "--transport", "http", "--scope", "user", CLIENT_NAME, &url(), "--header", &header]).await?;
        Ok(true)
    }

    /// Read from the file: `claude mcp get` connects to the server and prints text for people, with the token hidden.
    fn claude_code_entry(&self) -> Result<Value, Failure> {
        let dir = self.claude_dir.clone().or_else(dirs::home_dir).ok_or_else(|| Failure::failed("no home folder"))?;
        let path = dir.join(".claude.json");
        let failed = |e: &dyn std::fmt::Display| Failure::failed(format!("{}: {e}", path.display()));
        match std::fs::read(&path) {
            Ok(file) => Ok(serde_json::from_slice::<Value>(&file).map_err(|e| failed(&e))?["mcpServers"][CLIENT_NAME].clone()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
            Err(e) => Err(failed(&e)),
        }
    }

    async fn claude(&self, args: &[&str]) -> Result<(), Failure> {
        let mut cmd = command(&self.claude)?;
        if let Some(dir) = &self.claude_dir {
            cmd.env("CLAUDE_CONFIG_DIR", dir);
        }
        let child = spawn(cmd.args(args).stdin(Stdio::null()), &self.claude)?;
        let out = child.wait_with_output().await.map_err(Failure::failed)?;
        if out.status.success() {
            return Ok(());
        }
        Err(Failure::Failed(format!("{}: {} {}", out.status, String::from_utf8_lossy(&out.stderr), String::from_utf8_lossy(&out.stdout))))
    }

    async fn write_codex(&self, want: Want<'_>) -> Result<bool, Failure> {
        let mut cmd = command(&self.codex)?;
        if let Some(home) = &self.codex_home {
            cmd.env("CODEX_HOME", home);
        }
        let mut child = spawn(cmd.arg("app-server").stdin(Stdio::piped()), &self.codex)?;
        let mut server = AppServer {
            stdin: child.stdin.take().expect("stdin piped"),
            lines: BufReader::new(child.stdout.take().expect("stdout piped")).lines(),
            last_id: 0,
        };
        let mut stderr = child.stderr.take().expect("stderr piped");
        let mut said = Vec::new();
        // Read all along: a full pipe would stop Codex before it answers.
        let listen = async {
            while stderr.read_buf(&mut said).await.is_ok_and(|n| n > 0) {}
            std::future::pending::<()>().await;
        };
        let result = tokio::select! {
            result = change_codex(&mut server, want) => result,
            () = listen => unreachable!("listening never ends"),
        };
        // It leaves when its input closes.
        drop(server);
        match result {
            Ok(written) => {
                let _ = tokio::time::timeout(LEAVE, child.wait()).await;
                Ok(written)
            }
            Err(Refusal::Said(failure)) => Err(failure),
            Err(Refusal::Gone) => {
                let _ = stderr.read_to_end(&mut said).await;
                Err(Failure::Failed(format!("app-server ended: {}", String::from_utf8_lossy(&said))))
            }
        }
    }
}

fn command(program: &str) -> Result<Command, Failure> {
    // An empty working directory, like the AI providers: no project for the CLI to pick up.
    let cwd = std::env::temp_dir().join("lattice-mcp");
    std::fs::create_dir_all(&cwd).map_err(Failure::failed)?;
    let mut cmd = Command::new(program);
    cmd.current_dir(&cwd).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flash from the GUI app
    Ok(cmd)
}

fn spawn(cmd: &mut Command, program: &str) -> Result<tokio::process::Child, Failure> {
    let child = cmd.spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => Failure::Missing(program.to_string()),
        _ => Failure::failed(format!("{program}: {e}")),
    })?;
    #[cfg(windows)]
    crate::llm::end_with_this_process(&child);
    Ok(child)
}

/// `codex app-server`: JSON-RPC, one message a line.
struct AppServer {
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    last_id: u64,
}

enum Refusal {
    Said(Failure),
    /// It ended, or stopped talking, before it answered.
    Gone,
}

impl From<Failure> for Refusal {
    fn from(failure: Failure) -> Self {
        Self::Said(failure)
    }
}

impl AppServer {
    async fn send(&mut self, message: &Value) -> Result<(), Refusal> {
        self.stdin.write_all(format!("{message}\n").as_bytes()).await.map_err(|_| Refusal::Gone)
    }

    async fn call(&mut self, method: &str, params: Value) -> Result<Value, Refusal> {
        self.last_id += 1;
        self.send(&json!({ "id": self.last_id, "method": method, "params": params })).await?;
        while let Some(line) = self.lines.next_line().await.map_err(|_| Refusal::Gone)? {
            // Its notifications come in between, and a request of its own may carry the same number.
            let Ok(mut reply) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if reply["id"] != json!(self.last_id) || !reply["method"].is_null() {
                continue;
            }
            if let Some(error) = reply.get("error").filter(|e| !e.is_null()) {
                return Err(Failure::Failed(error["message"].as_str().map_or_else(|| error.to_string(), String::from)).into());
            }
            return Ok(reply["result"].take());
        }
        Err(Refusal::Gone)
    }
}

async fn change_codex(server: &mut AppServer, want: Want<'_>) -> Result<bool, Refusal> {
    server.call("initialize", json!({ "clientInfo": { "name": "lattice", "version": env!("CARGO_PKG_VERSION") } })).await?;
    server.send(&json!({ "method": "initialized" })).await?;
    let read = server.call("config/read", json!({ "includeLayers": true })).await?;
    // The user's own file. The merged settings could show a managed one's entry instead, and a profile is a layer too.
    let user = read["layers"].as_array().and_then(|layers| layers.iter().find(|l| l["name"]["type"] == "user" && l["name"]["profile"].is_null()));
    let (version, found) = user.map_or((&Value::Null, &Value::Null), |l| (&l["version"], &l["config"]["mcp_servers"][CLIENT_NAME]));
    let edits = match step(&entry(found, "http_headers"), want)? {
        Step::Leave => return Ok(false),
        Step::Remove => vec![codex_edit(&[], Value::Null)],
        Step::Add(token) | Step::Replace(token) => codex_put(found, token),
    };
    server.call("config/batchWrite", json!({ "edits": edits, "expectedVersion": version })).await?;
    Ok(true)
}

/// A null takes the key out. Anything else joins what is there, so keys the user added to the entry stay.
fn codex_edit(path: &[&str], value: Value) -> Value {
    let strategy = if value.is_null() {
        "replace"
    } else {
        "upsert"
    };
    let path = [&["mcp_servers", CLIENT_NAME], path].concat().join(".");
    json!({ "keyPath": path, "value": value, "mergeStrategy": strategy })
}

/// Besides the token, takes out what Codex would send in its place: `bearer_token_env_var` and `env_http_headers` win over
/// `http_headers` (checked with 0.164.0), and a variable that is not set ends the connection.
fn codex_put(found: &Value, token: &str) -> Vec<Value> {
    let header = "Authorization";
    let mut edits = Vec::new();
    if !found["bearer_token_env_var"].is_null() {
        edits.push(codex_edit(&["bearer_token_env_var"], Value::Null));
    }
    for table in ["http_headers", "env_http_headers"] {
        let names = found[table].as_object().into_iter().flat_map(|headers| headers.keys());
        let stale = names.filter(|name| name.eq_ignore_ascii_case(header) && !(table == "http_headers" && *name == header));
        edits.extend(stale.map(|name| codex_edit(&[table, name], Value::Null)));
    }
    edits.push(codex_edit(&[], json!({ "url": url(), "http_headers": { header: format!("Bearer {token}") } })));
    edits
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::{Edit, Registration, Role, edit};

    const URL: &str = "http://127.0.0.1:8789/mcp";

    /// Both agents with throwaway settings folders, removed with it.
    struct Sandbox {
        dir: PathBuf,
        agents: Agents,
        store: Store,
    }

    impl Sandbox {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("lattice-mcp-agents-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let agents = Agents { claude_dir: Some(dir.clone()), codex_home: Some(dir.clone()), ..Agents::default() };
            Self { dir, agents, store: Store::open_in_memory().unwrap() }
        }

        fn register(&self, target: Target) -> Registration {
            edit(&self.store, &Edit::Create { name: String::new(), role: Role::Read, target }).unwrap().unwrap()
        }

        fn regenerate(&self, r: &Registration) -> Registration {
            edit(&self.store, &Edit::Regenerate { id: r.id.clone() }).unwrap().unwrap()
        }

        fn delete(&self, r: &Registration) {
            edit(&self.store, &Edit::Delete { id: r.id.clone() }).unwrap();
        }

        /// False, with a word on it, when the agent's CLI is not installed.
        async fn installed(&self, r: &Registration) -> bool {
            let connected = self.agents.connect(&self.store, &r.id).await;
            if connected.as_ref().is_err_and(|e| e.contains("mcp.agentMissing")) {
                eprintln!("skipped: {connected:?}");
                return false;
            }
            assert_eq!(connected, Ok(true));
            true
        }

        fn file(&self, name: &str) -> String {
            std::fs::read_to_string(self.dir.join(name)).unwrap_or_default()
        }

        fn set(&self, name: &str, text: &str) {
            std::fs::write(self.dir.join(name), text).unwrap();
        }

        fn claude_servers(&self) -> Value {
            serde_json::from_str::<Value>(&self.file(".claude.json")).unwrap()["mcpServers"].clone()
        }

        /// A program that records how it was called in `<name>.txt` and then does `then`, as a batch file.
        #[cfg(windows)]
        fn fake(&self, name: &str, then: &str) -> String {
            let program = format!("{name}.cmd");
            self.set(&program, &format!("@echo %*>>\"%~dp0{name}.txt\"\r\n@{then}\r\n"));
            self.dir.join(program).to_string_lossy().into_owned()
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn message(error: &str) -> Value {
        serde_json::from_str(error).unwrap()
    }

    #[test]
    fn each_target_copies_what_its_agent_takes() {
        assert_eq!(
            copied(Target::ClaudeCode, "t0k"),
            r#"claude mcp add --transport http --scope user lattice-dev http://127.0.0.1:8789/mcp --header "Authorization: Bearer t0k""#
        );
        assert_eq!(
            copied(Target::ClaudeCodeProject, "t0k"),
            r#"claude mcp add --transport http --scope local lattice-dev http://127.0.0.1:8789/mcp --header "Authorization: Bearer t0k""#
        );
        assert_eq!(
            copied(Target::Codex, "t0k"),
            "[mcp_servers.lattice-dev]\nurl = \"http://127.0.0.1:8789/mcp\"\nhttp_headers = { Authorization = \"Bearer t0k\" }\n"
        );
        assert_eq!(
            serde_json::from_str::<Value>(&copied(Target::Other, "t0k")).unwrap(),
            json!({ "mcpServers": { "lattice-dev": { "type": "http", "url": URL, "headers": { "Authorization": "Bearer t0k" } } } })
        );
        assert_eq!(removal(Target::ClaudeCode).unwrap(), "claude mcp remove lattice-dev -s user");
        assert_eq!(removal(Target::ClaudeCodeProject).unwrap(), "claude mcp remove lattice-dev -s local", "following it must not remove the user-wide one");
        assert_eq!(removal(Target::Codex).unwrap(), "codex mcp remove lattice-dev");
        assert_eq!(removal(Target::Other), None);
    }

    #[test]
    fn an_entry_is_lattices_only_at_its_very_address() {
        assert_eq!(entry(&Value::Null, "headers"), Entry::Absent);
        let with = |headers: Value| entry(&json!({ "type": "http", "url": URL, "headers": headers }), "headers");
        assert_eq!(with(json!({ "X": "1", "Authorization": "Bearer t1" })), Entry::Lattices(Some("t1".into())));
        assert_eq!(with(json!({ "authorization": "Bearer t1" })), Entry::Lattices(Some("t1".into())));
        assert_eq!(with(json!({ "Authorization": "Basic t1" })), Entry::Lattices(None));
        assert_eq!(with(Value::Null), Entry::Lattices(None));
        assert_eq!(entry(&json!({ "url": URL, "http_headers": { "Authorization": "Bearer t2" } }), "http_headers"), Entry::Lattices(Some("t2".into())));
        for other in [
            json!({ "command": "lattice" }),
            json!({ "url": "http://127.0.0.1:8788/mcp" }),
            json!({ "url": "http://127.0.0.1:8789/mcp/" }),
            json!({ "url": 1 }),
            json!("x"),
        ] {
            assert_eq!(entry(&other, "headers"), Entry::SomeoneElses, "{other}");
        }
    }

    #[test]
    fn someone_elses_entry_is_never_changed_and_a_token_still_in_use_is_not_removed() {
        let ours = |token: &str| Entry::Lattices(Some(token.into()));
        assert!(matches!(step(&Entry::SomeoneElses, Want::Token("new")), Err(Failure::SomeoneElses)));
        assert_eq!(step(&Entry::Absent, Want::Token("new")).unwrap(), Step::Add("new"));
        for found in [ours("old"), ours("new"), Entry::Lattices(None)] {
            assert_eq!(step(&found, Want::Token("new")).unwrap(), Step::Replace("new"), "{found:?}");
        }
        let left = ["kept".to_string()];
        let gone = Want::Gone { left: &left };
        assert_eq!(step(&Entry::SomeoneElses, gone).unwrap(), Step::Leave);
        assert_eq!(step(&Entry::Absent, gone).unwrap(), Step::Leave);
        assert_eq!(step(&ours("kept"), gone).unwrap(), Step::Leave);
        assert_eq!(step(&ours("deleted"), gone).unwrap(), Step::Remove);
        assert_eq!(step(&Entry::Lattices(None), gone).unwrap(), Step::Remove);
    }

    #[test]
    fn what_codex_would_send_in_place_of_the_token_goes_and_the_users_other_keys_stay() {
        let put = json!({
            "keyPath": "mcp_servers.lattice-dev", "mergeStrategy": "upsert",
            "value": { "url": URL, "http_headers": { "Authorization": "Bearer new" } },
        });
        assert_eq!(codex_put(&Value::Null, "new"), std::slice::from_ref(&put));
        let found = json!({
            "url": URL, "startup_timeout_sec": 5, "bearer_token_env_var": "TOKEN",
            "http_headers": { "Authorization": "Bearer old", "authorization": "Bearer older", "X-Mine": "1" },
            "env_http_headers": { "Authorization": "TOKEN", "X-Mine-Too": "VAR" },
        });
        let gone = |key: &str| json!({ "keyPath": format!("mcp_servers.lattice-dev.{key}"), "value": null, "mergeStrategy": "replace" });
        assert_eq!(codex_put(&found, "new"), [gone("bearer_token_env_var"), gone("http_headers.authorization"), gone("env_http_headers.Authorization"), put]);
    }

    #[test]
    fn no_message_carries_a_token() {
        let token = "0123456789abcdef".repeat(4);
        let told = |error: String| message(&Failure::Failed(error).message("Codex"))["params"]["error"].as_str().unwrap().to_string();
        assert_eq!(told(format!("exit 1:\n  bad header \"Authorization: Bearer {token}\"\n")), "exit 1: bad header \"Authorization: ***\"");
        assert_eq!(told(format!("token={token}.")), "token=***.");
        assert_eq!(told("'Bearer sk-someone-elses-secret' rejected".into()), "'***' rejected");
        assert_eq!(told("no bearer token".into()), "no bearer token");
        assert_eq!(told("あ".repeat(1000)).chars().count(), MAX_ERROR_CHARS);
    }

    #[tokio::test]
    async fn a_missing_program_is_named() {
        let mut s = Sandbox::new("missing");
        s.agents.claude = "lattice-no-such-claude".into();
        s.agents.codex = "lattice-no-such-codex".into();
        for (target, agent, program) in [(Target::ClaudeCode, "Claude Code", "lattice-no-such-claude"), (Target::Codex, "Codex", "lattice-no-such-codex")] {
            let r = s.register(target);
            let e = s.agents.connect(&s.store, &r.id).await.unwrap_err();
            assert_eq!(message(&e), json!({ "code": "mcp.agentMissing", "params": { "agent": agent, "program": program } }));
        }
    }

    #[tokio::test]
    async fn a_target_the_app_does_not_write_and_a_registration_that_is_gone_run_nothing() {
        let mut s = Sandbox::new("untouched");
        s.agents.claude = "lattice-no-such-claude".into();
        s.agents.codex = "lattice-no-such-codex".into();
        for target in [Target::ClaudeCodeProject, Target::Other] {
            let r = edit(&s.store, &Edit::Create { name: format!("{target:?}"), role: Role::Read, target }).unwrap().unwrap();
            assert_eq!(s.agents.connect(&s.store, &r.id).await, Ok(false));
            s.delete(&r);
            assert_eq!(s.agents.disconnect(&s.store, target).await, Ok(false));
        }
        let r = s.register(Target::Codex);
        s.delete(&r);
        assert_eq!(s.agents.connect(&s.store, &r.id).await, Ok(false));
    }

    #[tokio::test]
    async fn a_change_waits_for_the_one_before_it_and_then_takes_the_token_as_stored() {
        let mut s = Sandbox::new("turns");
        s.agents.codex = "lattice-no-such-codex".into();
        let r = s.register(Target::Codex);
        let turn = WRITING.lock().await;
        let waiting = s.agents.connect(&s.store, &r.id);
        tokio::pin!(waiting);
        assert!(tokio::time::timeout(Duration::from_millis(50), &mut waiting).await.is_err(), "it waits its turn");
        s.delete(&r);
        drop(turn);
        assert_eq!(waiting.await, Ok(false), "deleted while it waited");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_program_that_does_not_answer_is_given_up_on() {
        let mut s = Sandbox::new("hanging");
        s.agents.timeout = Duration::from_millis(500);
        // Reads all it is sent, and answers nothing.
        s.agents.codex = "findstr".into();
        s.agents.claude = s.fake("claude", "rem\r\n:again\r\n@goto again");
        for target in [Target::Codex, Target::ClaudeCode] {
            let r = s.register(target);
            let started = std::time::Instant::now();
            let e = s.agents.connect(&s.store, &r.id).await.unwrap_err();
            assert_eq!(message(&e)["params"]["error"], "timed out after 500ms", "{target:?}");
            assert!(started.elapsed() < Duration::from_secs(15), "{target:?}");
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_codex_that_ends_before_answering_gives_what_it_said() {
        let mut s = Sandbox::new("old-codex");
        s.agents.codex = s.fake("codex", "echo error: unrecognized subcommand 1>&2& exit /b 2");
        let r = s.register(Target::Codex);
        let e = message(&s.agents.connect(&s.store, &r.id).await.unwrap_err());
        assert_eq!(e["code"], "mcp.agentFailed");
        assert_eq!(e["params"]["error"], "app-server ended: error: unrecognized subcommand");
        assert_eq!(s.file("codex.txt").trim(), "app-server");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn claude_code_is_called_for_lattices_entry_alone() {
        let mut s = Sandbox::new("claude-calls");
        s.agents.claude = s.fake("claude", "exit /b 0");
        let r = s.register(Target::ClaudeCode);
        let add = format!(r#"mcp add --transport http --scope user lattice-dev {URL} --header "Authorization: Bearer {}""#, r.token);
        let remove = "mcp remove lattice-dev -s user";
        let calls = || {
            let calls: Vec<String> = s.file("claude.txt").lines().map(|l| l.trim().to_string()).collect();
            s.set("claude.txt", "");
            calls
        };
        let holds = |entry: Value| s.set(".claude.json", &json!({ "mcpServers": { CLIENT_NAME: entry } }).to_string());

        assert_eq!(s.agents.connect(&s.store, &r.id).await, Ok(true));
        assert_eq!(calls(), [add.as_str()], "no settings file yet");
        holds(json!({ "type": "http", "url": URL }));
        assert_eq!(s.agents.connect(&s.store, &r.id).await, Ok(true));
        assert_eq!(calls(), [remove, &add], "`add` refuses a name it has");

        holds(json!({ "command": "mine" }));
        let e = s.agents.connect(&s.store, &r.id).await.unwrap_err();
        assert_eq!(message(&e), json!({ "code": "mcp.agentOther", "params": { "agent": "Claude Code", "name": "lattice-dev" } }));
        s.set(".claude.json", "{");
        let e = s.agents.connect(&s.store, &r.id).await.unwrap_err();
        assert!(e.contains("mcp.agentFailed") && e.contains(".claude.json"), "{e}");
        assert!(calls().is_empty(), "nothing for someone else's entry, nor over settings that cannot be read");

        holds(json!({ "url": URL, "headers": { "Authorization": format!("Bearer {}", r.token) } }));
        assert_eq!(s.agents.disconnect(&s.store, Target::ClaudeCode).await, Ok(false), "a registration that is left uses it");
        assert!(calls().is_empty());
        s.delete(&r);
        assert_eq!(s.agents.disconnect(&s.store, Target::ClaudeCode).await, Ok(true));
        assert_eq!(calls(), [remove]);
        s.set(".claude.json", "{}");
        assert_eq!(s.agents.disconnect(&s.store, Target::ClaudeCode).await, Ok(false), "already out");
        assert!(calls().is_empty());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_command_that_repeats_its_arguments_does_not_show_the_token() {
        let mut s = Sandbox::new("claude-fails");
        s.agents.claude = s.fake("claude", "echo cannot run %* 1>&2& exit /b 3");
        let r = s.register(Target::ClaudeCode);
        let e = s.agents.connect(&s.store, &r.id).await.unwrap_err();
        assert!(s.file("claude.txt").contains(&r.token), "it was called with it");
        assert!(!e.contains(&r.token) && e.contains("mcp.agentFailed") && e.contains("cannot run mcp add"), "{e}");
    }

    #[tokio::test]
    async fn the_installed_claude_code_takes_replaces_and_gives_up_the_registration() {
        let s = Sandbox::new("claude");
        let other = json!({ "type": "http", "url": "http://127.0.0.1:1/mcp" });
        s.set(".claude.json", &json!({ "mcpServers": { "other": other } }).to_string());
        let r = s.register(Target::ClaudeCode);
        if !s.installed(&r).await {
            return;
        }
        let ours = |token: &str| json!({ "type": "http", "url": URL, "headers": { "Authorization": format!("Bearer {token}") } });
        assert_eq!(s.claude_servers(), json!({ "other": other, CLIENT_NAME: ours(&r.token) }));
        let renewed = s.regenerate(&r);
        for _ in 0..2 {
            assert_eq!(s.agents.connect(&s.store, &r.id).await, Ok(true));
            assert_eq!(s.claude_servers(), json!({ "other": other, CLIENT_NAME: ours(&renewed.token) }), "the same however often");
        }
        s.delete(&r);
        for taken_out in [true, false] {
            assert_eq!(s.agents.disconnect(&s.store, Target::ClaudeCode).await, Ok(taken_out));
            assert_eq!(s.claude_servers(), json!({ "other": other }));
        }

        let mine = json!({ "type": "http", "url": "http://127.0.0.1:2/mcp" });
        s.set(".claude.json", &json!({ "mcpServers": { CLIENT_NAME: mine } }).to_string());
        let r = s.register(Target::ClaudeCode);
        assert!(s.agents.connect(&s.store, &r.id).await.unwrap_err().contains("mcp.agentOther"));
        s.delete(&r);
        assert_eq!(s.agents.disconnect(&s.store, Target::ClaudeCode).await, Ok(false));
        assert_eq!(s.claude_servers(), json!({ CLIENT_NAME: mine }));
    }

    #[tokio::test]
    async fn the_installed_codex_takes_replaces_and_gives_up_the_registration() {
        let s = Sandbox::new("codex");
        let before = "# my notes\nmodel = \"x\" # keep\n\n[mcp_servers.other]\ncommand = \"foo\" # other\n";
        s.set("config.toml", before);
        let r = s.register(Target::Codex);
        if !s.installed(&r).await {
            return;
        }
        let bearer = |token: &str| format!("Authorization = \"Bearer {token}\"");
        let written = s.file("config.toml");
        assert!(written.starts_with(before) && written.contains(&bearer(&r.token)) && written.contains(URL), "{written}");

        s.set(
            "config.toml",
            &format!(
                "{before}\n[mcp_servers.{CLIENT_NAME}] # mine\nurl = \"{URL}\"\nstartup_timeout_sec = 7\nbearer_token_env_var = \"NO_SUCH\"\n\
                 http_headers = {{ X-Mine = \"1\", {} }}\nenv_http_headers = {{ X-Env = \"VAR\", authorization = \"NO_SUCH\" }}\n",
                bearer(&r.token)
            ),
        );
        let renewed = s.regenerate(&r);
        for _ in 0..2 {
            assert_eq!(s.agents.connect(&s.store, &r.id).await, Ok(true));
            let written = s.file("config.toml");
            assert!(written.starts_with(before), "other servers and comments stay: {written}");
            for kept in ["# mine", "startup_timeout_sec = 7", "X-Mine", "X-Env", &bearer(&renewed.token)] {
                assert!(written.contains(kept), "{kept}: {written}");
            }
            for gone in [r.token.as_str(), "NO_SUCH", "bearer_token_env_var"] {
                assert!(!written.contains(gone), "{gone}: {written}");
            }
        }
        s.delete(&r);
        for taken_out in [true, false] {
            assert_eq!(s.agents.disconnect(&s.store, Target::Codex).await, Ok(taken_out));
            assert_eq!(s.file("config.toml").trim_end(), before.trim_end());
        }

        let mine = format!("[mcp_servers.{CLIENT_NAME}]\ncommand = \"mine\"\n");
        s.set("config.toml", &mine);
        let r = s.register(Target::Codex);
        assert!(s.agents.connect(&s.store, &r.id).await.unwrap_err().contains("mcp.agentOther"));
        let broken = "model = ";
        s.set("config.toml", broken);
        assert!(s.agents.connect(&s.store, &r.id).await.unwrap_err().contains("mcp.agentFailed"));
        assert_eq!(s.file("config.toml"), broken, "settings Codex cannot read are left alone");
        s.set("config.toml", &mine);
        s.delete(&r);
        assert_eq!(s.agents.disconnect(&s.store, Target::Codex).await, Ok(false));
        assert_eq!(s.file("config.toml"), mine);
    }
}
