//! Puts the app's MCP registrations in the agents' own user settings, and makes the text the settings screen copies where
//! the app does not (design-review §23).
//!
//! Claude Code is written through its CLI, so the format of its settings, its lock and its backups stay its business. Codex
//! has no way in that keeps the user's file: `codex mcp add` takes no literal header, only the name of an environment
//! variable the app cannot set for the user's shells, and `config/batchWrite` of `codex app-server` (0.164.0) breaks a file
//! with a comment above an inline table. So `config.toml` is edited here.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use serde_json::{Map, Value, json};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::Mutex;
use toml_edit::{Decor, DocumentMut, InlineTable, Item, TableLike};

use crate::mcp::{CLIENT_NAME, Target, registrations, url};
use crate::msg;
use crate::store::Store;

/// One change to an agent's settings at a time, each from the registrations as stored when its turn comes, so the last
/// one written holds the last token.
static WRITING: Mutex<()> = Mutex::const_new(());
/// An error a CLI prints is cut to this before the settings screen shows it.
const MAX_ERROR_CHARS: usize = 400;
const AUTHORIZATION: &str = "Authorization";

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

/// Where the agents' settings are, and the program that changes them.
pub struct Agents {
    claude: String,
    /// `CLAUDE_CONFIG_DIR`; None is the user's home folder.
    claude_dir: Option<PathBuf>,
    /// `CODEX_HOME`; None when there is no home folder either.
    codex_home: Option<PathBuf>,
    /// For one run of the program.
    timeout: Duration,
}

impl Default for Agents {
    fn default() -> Self {
        let folder = |variable| std::env::var_os(variable).filter(|d| !d.is_empty()).map(PathBuf::from);
        Self {
            claude: "claude".into(),
            claude_dir: folder("CLAUDE_CONFIG_DIR"),
            codex_home: folder("CODEX_HOME").or_else(|| dirs::home_dir().map(|home| home.join(".codex"))),
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
    let authorization = found[headers].as_object().and_then(|h| h.iter().find(|(name, _)| name.eq_ignore_ascii_case(AUTHORIZATION)));
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
        let written = match target {
            Target::ClaudeCode => self.write_claude_code(want).await,
            Target::Codex => self.write_codex(want),
            Target::ClaudeCodeProject | Target::Other => Ok(false),
        };
        let written = written.map_err(|f| f.message(agent)).inspect_err(|e| log::warn!("{agent}: {e}"))?;
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
        let found = self.claude_code_entry()?;
        let remove = ["mcp", "remove", CLIENT_NAME, "-s", "user"];
        // From stdin: other programs can read the arguments.
        let add = ["mcp", "add-json", "-s", "user", CLIENT_NAME, "-"];
        match step(&entry(&found, "headers"), want)? {
            Step::Leave => return Ok(false),
            Step::Remove => self.claude(&remove, "").await?,
            Step::Add(token) => self.claude(&add, &claude_code_with(&found, token).to_string()).await?,
            Step::Replace(token) => {
                let new = claude_code_with(&found, token);
                if new != found {
                    // `add-json` refuses a name it already has.
                    self.claude(&remove, "").await?;
                    if let Err(failure) = self.claude(&add, &new.to_string()).await {
                        // As an argument: run inside a session of its own, Claude Code refuses stdin (2.1.327).
                        let _ = self.claude(&["mcp", "add-json", "-s", "user", CLIENT_NAME, &found.to_string()], "").await;
                        return Err(failure);
                    }
                }
            }
        }
        Ok(true)
    }

    /// Read from the file: `claude mcp get` connects to the server and prints text for people, with the token hidden.
    fn claude_code_entry(&self) -> Result<Value, Failure> {
        let dir = self.claude_dir.clone().or_else(dirs::home_dir).ok_or_else(|| Failure::failed("no home folder"))?;
        let path = dir.join(".claude.json");
        let failed = |e: &dyn std::fmt::Display| Failure::failed(format!("{}: {e}", path.display()));
        match read(&path).map_err(|e| failed(&e))? {
            Some(file) => Ok(serde_json::from_slice::<Value>(&file).map_err(|e| failed(&e))?["mcpServers"][CLIENT_NAME].clone()),
            None => Ok(Value::Null),
        }
    }

    async fn claude(&self, args: &[&str], stdin: &str) -> Result<(), Failure> {
        let mut cmd = command(&self.claude)?;
        if let Some(dir) = &self.claude_dir {
            cmd.env("CLAUDE_CONFIG_DIR", dir);
        }
        let mut child = spawn(cmd.args(args).stdin(Stdio::piped()), &self.claude)?;
        let run = async {
            let mut input = child.stdin.take().expect("stdin piped");
            // A program that ends without reading it says why itself.
            let _ = input.write_all(stdin.as_bytes()).await;
            drop(input);
            child.wait_with_output().await
        };
        let out = tokio::time::timeout(self.timeout, run).await;
        let out = out.map_err(|_| Failure::Failed(format!("timed out after {:?}", self.timeout)))?.map_err(Failure::failed)?;
        if out.status.success() {
            return Ok(());
        }
        Err(Failure::Failed(format!("{}: {} {}", out.status, String::from_utf8_lossy(&out.stderr), String::from_utf8_lossy(&out.stdout))))
    }

    fn write_codex(&self, want: Want<'_>) -> Result<bool, Failure> {
        let home = self.codex_home.as_ref().ok_or_else(|| Failure::failed("no home folder"))?;
        let path = home.join("config.toml");
        let failed = |e: &dyn std::fmt::Display| Failure::failed(format!("{}: {e}", path.display()));
        let before = read(&path).map_err(|e| failed(&e))?;
        let text = std::str::from_utf8(before.as_deref().unwrap_or_default()).map_err(|e| failed(&e))?;
        let doc = parse_toml(text).map_err(|e| failed(&e))?;
        let after = match step(&codex_entry(&doc), want)? {
            Step::Leave => return Ok(false),
            Step::Add(token) | Step::Replace(token) => codex_with(text, token),
            Step::Remove => codex_without(text),
        };
        if !home.is_dir() {
            return Err(Failure::Missing(home.display().to_string()));
        }
        let after = after.map_err(|e| failed(&e))?;
        if after != text {
            overwrite(&path, before.as_deref(), &after).map_err(|e| failed(&e))?;
        }
        Ok(true)
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

fn read(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    match std::fs::read(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        file => file.map(Some),
    }
}

/// Puts `after` in place of `before`, whole or not at all.
fn overwrite(path: &Path, before: Option<&[u8]>, after: &str) -> std::io::Result<()> {
    // A linked file is replaced where it is, and the link stays.
    let path = match path.canonicalize() {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && !path.is_symlink() => path.to_path_buf(),
        found => found?,
    };
    if std::fs::metadata(&path).is_ok_and(|m| m.permissions().readonly()) {
        return Err(std::io::ErrorKind::PermissionDenied.into());
    }
    let part = path.with_added_extension(format!("{CLIENT_NAME}.part"));
    let write = || {
        let mut file = std::fs::File::create(&part)?;
        file.write_all(after.as_bytes())?;
        file.sync_all()?;
        // shortcut: a change made between this look and the rename is lost, take a lock once Codex has one for the file.
        if read(&path)?.as_deref() != before {
            return Err(std::io::Error::other("changed by something else meanwhile"));
        }
        std::fs::rename(&part, &path)
    };
    let written = write();
    if written.is_err() {
        let _ = std::fs::remove_file(&part);
    }
    written
}

/// The entry with the token, and with whatever else the user has in it.
fn claude_code_with(found: &Value, token: &str) -> Value {
    let mut entry = found.as_object().cloned().unwrap_or_default();
    let mut headers = entry.get("headers").and_then(Value::as_object).cloned().unwrap_or_default();
    headers.retain(|name, _| !name.eq_ignore_ascii_case(AUTHORIZATION));
    headers.insert(AUTHORIZATION.into(), format!("Bearer {token}").into());
    entry.insert("type".into(), "http".into());
    entry.insert("url".into(), url().into());
    entry.insert("headers".into(), headers.into());
    entry.into()
}

const SERVERS: &str = "mcp_servers";
const HEADERS: &str = "http_headers";
/// What cannot be in a TOML file, put on a line to find it again in the text.
const MARK: &str = "\u{1}";
const CANNOT_KEEP: &str = "it cannot be changed without rewriting other parts of it";

/// The error's own text would quote a line, with whatever secret is on it.
fn parse_toml(text: &str) -> Result<DocumentMut, String> {
    text.parse::<DocumentMut>().map_err(|e| {
        let line = e.span().and_then(|at| text.get(..at.start)).map_or(1, |above| above.matches('\n').count() + 1);
        format!("line {line}: {}", e.message())
    })
}

fn codex_entry(doc: &DocumentMut) -> Entry {
    let Some(found) = doc.get(SERVERS).and_then(|servers| servers.get(CLIENT_NAME)) else {
        return Entry::Absent;
    };
    let headers = found.get(HEADERS).and_then(Item::as_table_like).into_iter().flat_map(|headers| headers.iter());
    let headers: Map<String, Value> = headers.filter_map(|(name, value)| Some((name.into(), value.as_str()?.into()))).collect();
    entry(&json!({ "url": found.get("url").and_then(Item::as_str), HEADERS: headers }), HEADERS)
}

fn codex_with(text: &str, token: &str) -> Result<String, String> {
    let doc = parse_toml(text)?;
    let after = if codex_entry(&doc) == Entry::Absent && doc.get(SERVERS).is_none_or(Item::is_table) {
        let eol = eol(text);
        let gap = match text {
            "" => "",
            t if t.ends_with('\n') => "\n",
            _ => "\n\n",
        };
        format!("{text}{}", format!("{gap}{}", copied(Target::Codex, token)).replace('\n', eol))
    } else {
        edited(text, |doc| put_codex(doc, token).map(|()| doc.to_string()))?
    };
    checked(after, &Entry::Lattices(Some(token.into())))
}

fn codex_without(text: &str) -> Result<String, String> {
    checked(edited(text, take_out_codex)?, &Entry::Absent)
}

fn checked(after: String, holds: &Entry) -> Result<String, String> {
    if codex_entry(&parse_toml(&after)?) == *holds {
        Ok(after)
    } else {
        Err(CANNOT_KEEP.into())
    }
}

fn eol(text: &str) -> &'static str {
    if text.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

/// The text with the change to its document made. `toml_edit` writes LF, ends the last line, drops a byte order mark and
/// may reorder dotted keys: the first three are put right, and text it would change in any other way is refused.
fn edited(text: &str, change: impl FnOnce(&mut DocumentMut) -> Option<String>) -> Result<String, String> {
    let body = text.trim_start_matches('\u{feff}');
    let (mark, eol) = (&text[..text.len() - body.len()], eol(body));
    let lines = body.replace("\r\n", "\n");
    let mut doc = parse_toml(&lines)?;
    let whole = doc.to_string();
    let after = change(&mut doc).ok_or(CANNOT_KEEP)?;
    if after == whole {
        return Ok(text.into());
    }
    let added = match whole.strip_prefix(&lines) {
        Some("") => "",
        Some("\n") => "\n",
        _ => return Err(CANNOT_KEEP.into()),
    };
    if lines.replace('\n', eol) != body {
        return Err(CANNOT_KEEP.into());
    }
    Ok(format!("{mark}{}", after.strip_suffix(added).unwrap_or(&after).replace('\n', eol)))
}

/// Besides the token, takes out what Codex would send in its place: `bearer_token_env_var` and `env_http_headers` win over
/// `http_headers` (checked with 0.164.0), and a variable that is not set ends the connection. None where something has
/// another form than Codex reads.
fn put_codex(doc: &mut DocumentMut, token: &str) -> Option<()> {
    let bearer = format!("Bearer {token}");
    let fresh = || InlineTable::from_iter([(AUTHORIZATION, &bearer)]);
    let servers = doc.get_mut(SERVERS)?;
    if servers.get(CLIENT_NAME).is_none() {
        let entry = InlineTable::from_iter([("url", toml_edit::Value::from(url())), (HEADERS, fresh().into())]);
        return within(servers, |servers| drop(servers.insert(CLIENT_NAME, toml_edit::value(entry))));
    }
    let found = servers.as_table_like_mut()?.get_mut(CLIENT_NAME)?;
    let entry = found.as_table_like_mut()?;
    if let Some(headers) = entry.get_mut("env_http_headers") {
        within(headers, |headers| drop_authorization(headers, None))?;
    }
    if let Some(headers) = entry.get_mut(HEADERS) {
        within(headers, |headers| {
            drop_authorization(headers, Some(AUTHORIZATION));
            match headers.get_mut(AUTHORIZATION) {
                None => drop(headers.insert(AUTHORIZATION, toml_edit::value(&bearer))),
                Some(item) if item.as_str() == Some(&bearer) => (),
                Some(item) => {
                    let mut new = toml_edit::Value::from(&bearer);
                    if let Some(old) = item.as_value() {
                        *new.decor_mut() = old.decor().clone();
                    }
                    *item = Item::Value(new);
                }
            }
        })?;
    }
    within(found, |entry| {
        entry.remove("bearer_token_env_var");
        if !entry.contains_key(HEADERS) {
            entry.insert(HEADERS, toml_edit::value(fresh()));
        }
    })
}

fn drop_authorization(headers: &mut dyn TableLike, but: Option<&str>) {
    let stale = |name: &&str| name.eq_ignore_ascii_case(AUTHORIZATION) && Some(*name) != but;
    let names: Vec<String> = headers.iter().map(|(name, _)| name).filter(stale).map(String::from).collect();
    for name in names {
        headers.remove(&name);
    }
}

/// Changes a table; None where the item is none. What stands before an inline table's closing brace is its last value's,
/// so it is handed on to the one that is last afterwards.
fn within(item: &mut Item, change: impl FnOnce(&mut dyn TableLike)) -> Option<()> {
    fn last(item: &mut Item) -> Option<&mut Decor> {
        item.as_inline_table_mut()?.iter_mut().last().map(|(_, value)| value.decor_mut())
    }
    let before_brace = last(item).and_then(|decor| {
        let suffix = decor.suffix().cloned();
        decor.set_suffix("");
        suffix
    });
    change(item.as_table_like_mut()?);
    if let (Some(suffix), Some(decor)) = (before_brace, last(item)) {
        decor.set_suffix(suffix);
    }
    Some(())
}

/// The comments above the entry stay: they may be about the whole file.
fn take_out_codex(doc: &mut DocumentMut) -> Option<String> {
    let servers = doc.get_mut(SERVERS)?;
    if servers.is_inline_table() {
        within(servers, |servers| drop(servers.remove(CLIENT_NAME)))?;
        return Some(doc.to_string());
    }
    let (mut key, item) = servers.as_table_mut()?.get_key_value_mut(CLIENT_NAME)?;
    match item {
        Item::Table(table) if !table.is_dotted() => {
            table.clear();
            table.decor_mut().set_suffix(MARK);
        }
        _ => {
            let above = item.as_table().and_then(|dotted| dotted.get_values().first()?.0.last()?.leaf_decor().prefix().cloned());
            if let Some(above) = above {
                key.leaf_decor_mut().set_prefix(above);
            }
            *item = toml_edit::value("");
            item.as_value_mut()?.decor_mut().set_suffix(MARK);
        }
    }
    let text = doc.to_string();
    let (above, below) = text.split_once(MARK)?;
    let above = &above[..above.rfind('\n').map_or(0, |at| at + 1)];
    let below = below.strip_prefix('\n').unwrap_or(below);
    // Of the blank lines on its two sides, one is left.
    Some(match below.strip_prefix('\n') {
        Some(rest) if above.is_empty() => rest.to_string(),
        Some(rest) if above.ends_with("\n\n") => format!("{above}{rest}"),
        None if below.is_empty() && above.ends_with("\n\n") => above[..above.len() - 1].to_string(),
        _ => format!("{above}{below}"),
    })
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

        /// False, with a word on it, when the agent's CLI is not installed or takes no server from stdin where this runs.
        async fn installed(&self, r: &Registration) -> bool {
            let connected = self.agents.connect(&self.store, &r.id).await;
            if connected.as_ref().is_err_and(|e| e.contains("mcp.agentMissing") || e.contains("inside a Claude Code session")) {
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

        /// A program that records how it was called and what it was sent in `<name>.txt` and then does `then`, as a batch file.
        #[cfg(windows)]
        fn fake(&self, name: &str, then: &str) -> String {
            let program = format!("{name}.cmd");
            self.set(&program, &format!("@echo %*>>\"%~dp0{name}.txt\"\r\n@findstr \"^\">>\"%~dp0{name}.txt\"\r\n@{then}\r\n"));
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
    async fn a_missing_program_or_settings_folder_is_named() {
        let mut s = Sandbox::new("missing");
        let home = s.dir.join("no-such-codex");
        s.agents.claude = "lattice-no-such-claude".into();
        s.agents.codex_home = Some(home.clone());
        let home = home.to_string_lossy().into_owned();
        for (target, agent, program) in [(Target::ClaudeCode, "Claude Code", "lattice-no-such-claude"), (Target::Codex, "Codex", &home)] {
            let r = s.register(target);
            let e = s.agents.connect(&s.store, &r.id).await.unwrap_err();
            assert_eq!(message(&e), json!({ "code": "mcp.agentMissing", "params": { "agent": agent, "program": program } }));
            s.delete(&r);
            assert_eq!(s.agents.disconnect(&s.store, target).await, Ok(false), "nothing to take out");
        }
        assert!(!std::fs::exists(home).unwrap(), "no settings for an agent that is not there");
    }

    #[tokio::test]
    async fn a_target_the_app_does_not_write_and_a_registration_that_is_gone_run_nothing() {
        let mut s = Sandbox::new("untouched");
        s.agents.claude = "lattice-no-such-claude".into();
        s.agents.codex_home = Some(s.dir.join("no-such-codex"));
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
        let s = Sandbox::new("turns");
        let r = s.register(Target::Codex);
        let turn = WRITING.lock().await;
        let waiting = s.agents.connect(&s.store, &r.id);
        tokio::pin!(waiting);
        assert!(tokio::time::timeout(Duration::from_millis(50), &mut waiting).await.is_err(), "it waits its turn");
        s.delete(&r);
        drop(turn);
        assert_eq!(waiting.await, Ok(false), "deleted while it waited");
        assert_eq!(s.file("config.toml"), "");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_program_that_does_not_answer_is_given_up_on() {
        let mut s = Sandbox::new("hanging");
        s.agents.timeout = Duration::from_millis(500);
        s.agents.claude = s.fake("claude", "rem\r\n:again\r\n@goto again");
        let r = s.register(Target::ClaudeCode);
        let started = std::time::Instant::now();
        let e = s.agents.connect(&s.store, &r.id).await.unwrap_err();
        assert_eq!(message(&e)["params"]["error"], "timed out after 500ms");
        assert!(started.elapsed() < Duration::from_secs(15));
    }

    #[test]
    fn claude_codes_entry_keeps_what_the_user_has_in_it() {
        let fresh = json!({ "type": "http", "url": URL, "headers": { "Authorization": "Bearer new" } });
        assert_eq!(claude_code_with(&Value::Null, "new"), fresh);
        assert_eq!(claude_code_with(&json!({ "url": URL }), "new"), fresh);
        assert_eq!(claude_code_with(&fresh, "new"), fresh);
        let found = json!({
            "type": "streamable-http", "url": URL, "timeout": 5000, "alwaysLoad": true,
            "headers": { "Authorization": "Bearer old", "authorization": "Bearer older", "X-Mine": "1" },
        });
        let with = json!({ "type": "http", "url": URL, "timeout": 5000, "alwaysLoad": true, "headers": { "Authorization": "Bearer new", "X-Mine": "1" } });
        assert_eq!(claude_code_with(&found, "new"), with);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn claude_code_is_called_for_lattices_entry_alone() {
        let mut s = Sandbox::new("claude-calls");
        s.agents.claude = s.fake("claude", "exit /b 0");
        let r = s.register(Target::ClaudeCode);
        let (add, remove) = ("mcp add-json -s user lattice-dev -", "mcp remove lattice-dev -s user");
        let ours = json!({ "type": "http", "url": URL, "headers": { "Authorization": format!("Bearer {}", r.token) } });
        let calls = || {
            let calls: Vec<String> = s.file("claude.txt").lines().map(|l| l.trim().to_string()).collect();
            s.set("claude.txt", "");
            calls
        };
        let holds = |entry: &Value| s.set(".claude.json", &json!({ "mcpServers": { CLIENT_NAME: entry } }).to_string());

        assert_eq!(s.agents.connect(&s.store, &r.id).await, Ok(true));
        assert_eq!(calls(), [add, &ours.to_string()], "no settings file yet");
        holds(&json!({ "type": "http", "url": URL, "timeout": 5000 }));
        assert_eq!(s.agents.connect(&s.store, &r.id).await, Ok(true));
        let mut kept = ours.clone();
        kept["timeout"] = json!(5000);
        assert_eq!(calls(), [remove, add, &kept.to_string()], "`add-json` refuses a name it has");
        holds(&kept);
        assert_eq!(s.agents.connect(&s.store, &r.id).await, Ok(true));
        assert!(calls().is_empty(), "it is there already");

        holds(&json!({ "command": "mine" }));
        let e = s.agents.connect(&s.store, &r.id).await.unwrap_err();
        assert_eq!(message(&e), json!({ "code": "mcp.agentOther", "params": { "agent": "Claude Code", "name": "lattice-dev" } }));
        s.set(".claude.json", "{");
        let e = s.agents.connect(&s.store, &r.id).await.unwrap_err();
        assert!(e.contains("mcp.agentFailed") && e.contains(".claude.json"), "{e}");
        assert!(calls().is_empty(), "nothing for someone else's entry, nor over settings that cannot be read");

        holds(&ours);
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
    async fn an_entry_claude_code_will_not_replace_is_put_back() {
        for (fails, error) in [("echo no stdin 1>&2& exit /b 3", "exit code: 3: no stdin"), ("rem\r\n:again\r\n@goto again", "timed out after 3s")] {
            let mut s = Sandbox::new("claude-put-back");
            s.agents.timeout = Duration::from_secs(3);
            s.agents.claude = s.fake("claude", &format!("if not \"%6\"==\"-\" exit /b 0\r\n@{fails}"));
            let r = s.register(Target::ClaudeCode);
            let old = json!({ "headers": { "Authorization": "Bearer old" }, "timeout": 5000, "type": "http", "url": URL });
            s.set(".claude.json", &json!({ "mcpServers": { CLIENT_NAME: old } }).to_string());
            let e = message(&s.agents.connect(&s.store, &r.id).await.unwrap_err());
            assert_eq!(e["params"]["error"].as_str().unwrap().trim(), error, "the first failure");
            let calls: Vec<String> = s.file("claude.txt").lines().map(|l| l.trim().replace("\"\"", "\"")).collect();
            assert_eq!(calls.len(), 4, "{calls:?}");
            assert_eq!(calls[..2], ["mcp remove lattice-dev -s user", "mcp add-json -s user lattice-dev -"]);
            assert!(calls[2].contains(&r.token), "{calls:?}");
            assert_eq!(calls[3], format!("mcp add-json -s user lattice-dev \"{old}\""));
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_command_that_repeats_its_input_does_not_show_the_token() {
        let mut s = Sandbox::new("claude-fails");
        s.agents.claude = s.fake("claude", "type \"%~dp0claude.txt\" 1>&2& exit /b 3");
        let r = s.register(Target::ClaudeCode);
        let e = s.agents.connect(&s.store, &r.id).await.unwrap_err();
        assert!(s.file("claude.txt").contains(&r.token), "it was sent it");
        assert!(!e.contains(&r.token) && e.contains("mcp.agentFailed") && e.contains("add-json") && e.contains("***"), "{e}");
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
        let ours = |token: &str| {
            let mut ours = ours(token);
            ours["headers"]["X-Mine"] = json!("1");
            ours["timeout"] = json!(5000);
            ours["alwaysLoad"] = json!(true);
            ours
        };
        s.set(".claude.json", &json!({ "mcpServers": { "other": other, CLIENT_NAME: ours(&r.token) } }).to_string());
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

    const AT: &str = "url = \"http://127.0.0.1:8789/mcp\"";

    /// What becomes of `before` when a registration is put in and, if `gone`, taken out again, with its token as `NEW`.
    async fn codex_file(before: &str, gone: bool) -> Result<String, String> {
        static RUN: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let s = Sandbox::new(&format!("codex-{}", RUN.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        s.set("config.toml", before);
        let r = s.register(Target::Codex);
        let written = if gone {
            s.delete(&r);
            s.agents.disconnect(&s.store, Target::Codex).await.map(|done| assert!(done, "{before}"))
        } else {
            s.agents.connect(&s.store, &r.id).await.map(|done| assert!(done, "{before}"))
        };
        let after = s.file("config.toml");
        let files: Vec<_> = std::fs::read_dir(&s.dir).unwrap().map(|f| f.unwrap().file_name()).collect();
        assert_eq!(files, ["config.toml"], "nothing is left beside it");
        if let Err(e) = written {
            assert_eq!(after, before, "left alone");
            return Err(e);
        }
        if !gone {
            assert_eq!(s.agents.connect(&s.store, &r.id).await, Ok(true), "{before}");
            assert_eq!(s.file("config.toml"), after, "the same however often");
            assert!(s.agents.disconnect(&s.store, Target::Codex).await == Ok(false) && s.file("config.toml") == after, "still in use");
        }
        Ok(after.replace(&r.token, "NEW"))
    }

    #[tokio::test]
    async fn codex_gets_the_token_and_the_rest_of_its_file_stays_as_it_is() {
        let token = "[mcp_servers.lattice-dev]\n{AT}\nhttp_headers = { Authorization = \"Bearer NEW\" }\n";
        for (before, after) in [
            // Not there yet.
            ("", token),
            ("model = \"x\" # keep", "model = \"x\" # keep\n\n{TOKEN}"),
            ("# my notes\nmodel = \"x\"\n\n[mcp_servers.other]\ncommand = \"foo\" # other\n\n# the end\n", "{BEFORE}\n{TOKEN}"),
            ("[mcp_servers]\nother = { command = \"foo\" }\n[a]\n[b]\n[a.c]\n", "{BEFORE}\n{TOKEN}"),
            ("mcp_servers.other.command = \"foo\"\n", "{BEFORE}\n{TOKEN}"),
            // What `toml_edit` would reorder is no matter where the entry only joins.
            ("a.x = 1\nb = 2\na.y = 3\n", "{BEFORE}\n{TOKEN}"),
            (
                "# mine\nmcp_servers = { other = { command = \"foo\" } } # all\n",
                "# mine\nmcp_servers = { other = { command = \"foo\" }, lattice-dev = { {AT}, http_headers = { Authorization = \"Bearer NEW\" } } } # all\n",
            ),
            ("mcp_servers = {}\n", "mcp_servers = { lattice-dev = { {AT}, http_headers = { Authorization = \"Bearer NEW\" } } }\n"),
            // Inline headers, with comments wherever one can be.
            (
                "# head\n\n[mcp_servers.lattice-dev] # ours\n{AT} # at\n# Lattice token\nhttp_headers = { Authorization = \"Bearer old\" } # token\n# wait\nstartup_timeout_sec = 9\ntool_timeout_sec = 9.0 # s\n\n[other] # x\n",
                "# head\n\n[mcp_servers.lattice-dev] # ours\n{AT} # at\n# Lattice token\nhttp_headers = { Authorization = \"Bearer NEW\" } # token\n# wait\nstartup_timeout_sec = 9\ntool_timeout_sec = 9.0 # s\n\n[other] # x\n",
            ),
            // A table of headers.
            (
                "[mcp_servers.lattice-dev]\n{AT}\nstartup_timeout_sec = 9\n\n# sent\n[mcp_servers.lattice-dev.http_headers] # h\nX-Mine = '1' # x\n# token\nAuthorization   =   'Bearer old' # t\n",
                "[mcp_servers.lattice-dev]\n{AT}\nstartup_timeout_sec = 9\n\n# sent\n[mcp_servers.lattice-dev.http_headers] # h\nX-Mine = '1' # x\n# token\nAuthorization   =   \"Bearer NEW\" # t\n",
            ),
            // Dotted and quoted keys.
            (
                "# c\nmcp_servers.lattice-dev.{AT}\n# t\nmcp_servers.lattice-dev.http_headers.Authorization = \"Bearer old\" # x\nmodel = \"m\"\n",
                "# c\nmcp_servers.lattice-dev.{AT}\n# t\nmcp_servers.lattice-dev.http_headers.Authorization = \"Bearer NEW\" # x\nmodel = \"m\"\n",
            ),
            (
                "['mcp_servers' . \"lattice-dev\"]\n\"url\" = 'http://127.0.0.1:8789/mcp'\n  \"http_headers\" . 'Authorization' = \"Bearer old\"\n",
                "['mcp_servers' . \"lattice-dev\"]\n\"url\" = 'http://127.0.0.1:8789/mcp'\n  \"http_headers\" . 'Authorization' = \"Bearer NEW\"\n",
            ),
            // Inline all the way, with a comment above.
            (
                "# servers\nmcp_servers = { lattice-dev = { {AT}, http_headers = {X-Mine=\"1\",Authorization=\"Bearer old\"}, startup_timeout_sec = 9 }, other = { command = \"foo\" } } # all\n",
                "# servers\nmcp_servers = { lattice-dev = { {AT}, http_headers = {X-Mine=\"1\",Authorization=\"Bearer NEW\"}, startup_timeout_sec = 9 }, other = { command = \"foo\" } } # all\n",
            ),
            (
                "[mcp_servers]\n# Lattice\nlattice-dev = { {AT}, http_headers = { Authorization = \"Bearer old\" } }\nother = { command = \"foo\" }\n",
                "[mcp_servers]\n# Lattice\nlattice-dev = { {AT}, http_headers = { Authorization = \"Bearer NEW\" } }\nother = { command = \"foo\" }\n",
            ),
            (
                "[mcp_servers.lattice-dev]
{AT}
http_headers = {
  # t
  Authorization = \"Bearer old\", # u
  X-Mine = \"1\" # x
}
",
                "[mcp_servers.lattice-dev]
{AT}
http_headers = {
  # t
  Authorization = \"Bearer NEW\", # u
  X-Mine = \"1\" # x
}
",
            ),
            // No token yet.
            ("[mcp_servers.lattice-dev]\n{AT}\n\n[z]\n", "[mcp_servers.lattice-dev]\n{AT}\nhttp_headers = { Authorization = \"Bearer NEW\" }\n\n[z]\n"),
            (
                "[mcp_servers.lattice-dev]\n{AT}\nhttp_headers = { X-Mine = \"1\" } # x\n",
                "[mcp_servers.lattice-dev]\n{AT}\nhttp_headers = { X-Mine = \"1\", Authorization = \"Bearer NEW\" } # x\n",
            ),
            ("mcp_servers = { lattice-dev = { {AT} } }\n", "mcp_servers = { lattice-dev = { {AT}, http_headers = { Authorization = \"Bearer NEW\" } } }\n"),
            // What Codex would send in its place goes.
            (
                "[mcp_servers.lattice-dev]\n{AT}\nbearer_token_env_var = \"TOKEN\"\nhttp_headers = { Authorization = \"Bearer old\", X-Mine = \"1\", authorization = \"Bearer older\" }\n# from outside\nenv_http_headers = { AUTHORIZATION = \"TOKEN\", X-Mine-Too = \"VAR\" } # vars\n",
                "[mcp_servers.lattice-dev]\n{AT}\nhttp_headers = { Authorization = \"Bearer NEW\", X-Mine = \"1\" }\n# from outside\nenv_http_headers = { X-Mine-Too = \"VAR\" } # vars\n",
            ),
            (
                "mcp_servers = { lattice-dev = { {AT}, bearer_token_env_var = \"TOKEN\" } }\n",
                "mcp_servers = { lattice-dev = { {AT}, http_headers = { Authorization = \"Bearer NEW\" } } }\n",
            ),
            // The end of the file, the marks on its lines and the one before them.
            (
                "[mcp_servers.lattice-dev]\n{AT}\nhttp_headers = { Authorization = \"Bearer old\" }",
                "[mcp_servers.lattice-dev]\n{AT}\nhttp_headers = { Authorization = \"Bearer NEW\" }",
            ),
            ("\u{feff}model = 1\r\n", "\u{feff}model = 1\r\n\r\n{CRLF}"),
            (
                "\u{feff}notes = \"\"\"a\r\nb\"\"\"\r\n# c\r\n[mcp_servers.lattice-dev]\r\n{AT}\r\n# t\r\nhttp_headers = { Authorization = \"Bearer old\" } # x\r\n",
                "\u{feff}notes = \"\"\"a\r\nb\"\"\"\r\n# c\r\n[mcp_servers.lattice-dev]\r\n{AT}\r\n# t\r\nhttp_headers = { Authorization = \"Bearer NEW\" } # x\r\n",
            ),
        ] {
            let before = before.replace("{AT}", AT);
            let after = after.replace("{TOKEN}", token).replace("{CRLF}", &token.replace('\n', "\r\n")).replace("{BEFORE}", &before).replace("{AT}", AT);
            assert_eq!(codex_file(&before, false).await.unwrap(), after);
        }
    }

    #[tokio::test]
    async fn codex_loses_the_entry_and_nothing_else() {
        let ours = format!("[mcp_servers.lattice-dev] # ours\n{AT}\n# t\nhttp_headers = {{ Authorization = \"Bearer old\" }} # t\n");
        for (before, after) in [
            ("a = 1 # a\n\n{OURS}", "a = 1 # a\n"),
            ("a = 1\n\n{OURS}\n[z] # z\n", "a = 1\n\n[z] # z\n"),
            ("a = 1\n{OURS}[z]\n", "a = 1\n[z]\n"),
            ("{OURS}\n[z]\n", "[z]\n"),
            ("# my Codex\n\n# Lattice\n{OURS}\n# z\n[z]\n", "# my Codex\n\n# Lattice\n\n# z\n[z]\n"),
            ("[z]\n# Lattice\n{OURS}# the end\n", "[z]\n# Lattice\n# the end\n"),
            (
                "{OURS}# mine\nstartup_timeout_sec = 9\n\n[mcp_servers.lattice-dev.env_http_headers]\nX = \"V\"\n\n[mcp_servers.z]\nurl = \"u\"\n",
                "[mcp_servers.z]\nurl = \"u\"\n",
            ),
            ("{OURS}", ""),
            (
                "# head\nmcp_servers.lattice-dev.{AT}\n# in between\nmcp_servers.lattice-dev.http_headers.Authorization = \"Bearer old\"\n# m\nmodel = \"m\"\n",
                "# head\n# m\nmodel = \"m\"\n",
            ),
            (
                "[mcp_servers]\n\n# Lattice\nlattice-dev = { {AT} } # x\nother = { command = \"foo\" } # o\n",
                "[mcp_servers]\n\n# Lattice\nother = { command = \"foo\" } # o\n",
            ),
            (
                "# all\nmcp_servers = { other = { command = \"foo\" }, lattice-dev = { {AT} } } # s\n",
                "# all\nmcp_servers = { other = { command = \"foo\" } } # s\n",
            ),
            (
                "# all\nmcp_servers = { lattice-dev = { {AT} }, other = { command = \"foo\" } } # s\n",
                "# all\nmcp_servers = { other = { command = \"foo\" } } # s\n",
            ),
            ("\u{feff}# head\r\n[mcp_servers.lattice-dev]\r\n{AT}\r\n\r\n[z]\r\nn = 9\r\n", "\u{feff}# head\r\n\r\n[z]\r\nn = 9\r\n"),
            ("[z]\n\n{OURS}", "[z]\n"),
        ] {
            let before = before.replace("{OURS}", &ours).replace("{AT}", AT);
            assert_eq!(codex_file(&before, true).await.unwrap(), after);
        }
        for before in ["", "a = 1\n", "# c\n[mcp_servers.other]\nurl = \"u\"\n\n# the end\n", "a = 1\r\n"] {
            let added = codex_file(before, false).await.unwrap();
            assert_eq!(codex_file(&added, true).await.unwrap(), before, "there and back");
        }
    }

    #[tokio::test]
    async fn codex_settings_that_cannot_be_changed_safely_are_left_alone() {
        let secret = "0123456789abcdef".repeat(4);
        for (before, reason) in [
            // Not TOML: the line is named, and what is on it is not.
            (format!("model = 1\nkey = \"sk-{secret}\" \"Basic c2VjcmV0\"\n"), "line 2: "),
            (format!("[mcp_servers.lattice-dev]\n{AT}\nhttp_headers = {{ Authorization = \"Bearer {secret}\n"), "line 3: "),
            ("mcp_servers = \"none\"\n".into(), CANNOT_KEEP),
            ("[[mcp_servers]]\nurl = \"u\"\n".into(), CANNOT_KEEP),
            (format!("[mcp_servers.lattice-dev]\n{AT}\nhttp_headers = \"{secret}\"\n"), CANNOT_KEEP),
            // `toml_edit` would reorder the one and even out the line ends of the other.
            (format!("a.x = 1\nb = 2\na.y = 3\n[mcp_servers.lattice-dev]\n{AT}\n"), CANNOT_KEEP),
            (format!("a = 1\r\n[mcp_servers.lattice-dev]\n{AT}\n"), CANNOT_KEEP),
        ] {
            let e = codex_file(&before, false).await.unwrap_err();
            assert!(e.contains("mcp.agentFailed") && e.contains("config.toml") && e.contains(reason), "{before}: {e}");
            assert!(!e.contains("0123") && !e.contains("c2Vj"), "{e}");
        }
        let other = "[mcp_servers.lattice-dev]\ncommand = \"mine\"\n";
        assert!(codex_file(other, false).await.unwrap_err().contains("mcp.agentOther"));

        let s = Sandbox::new("codex-kept");
        let r = s.register(Target::Codex);
        s.delete(&r);
        for before in [other, "mcp_servers = \"none\"\n", "a.x = 1\nb = 2\na.y = 3\n"] {
            s.set("config.toml", before);
            assert_eq!(s.agents.disconnect(&s.store, Target::Codex).await, Ok(false));
            assert_eq!(s.file("config.toml"), before);
        }
    }

    #[tokio::test]
    async fn a_read_only_codex_file_is_left_alone_and_a_linked_one_is_changed_where_it_is() {
        let s = Sandbox::new("codex-files");
        let path = s.dir.join("config.toml");
        s.set("config.toml", "a = 1\n");
        let r = s.register(Target::Codex);
        let read_only = |yes: bool| {
            let mut permissions = std::fs::metadata(&path).unwrap().permissions();
            permissions.set_readonly(yes);
            std::fs::set_permissions(&path, permissions).unwrap();
        };
        read_only(true);
        let e = s.agents.connect(&s.store, &r.id).await;
        read_only(false);
        assert!(e.unwrap_err().contains("mcp.agentFailed"));
        assert_eq!(s.file("config.toml"), "a = 1\n");

        let linked = s.dir.join("dotfiles");
        std::fs::create_dir(&linked).unwrap();
        std::fs::rename(&path, linked.join("codex.toml")).unwrap();
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(linked.join("codex.toml"), &path);
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(linked.join("codex.toml"), &path);
        if let Err(e) = made {
            eprintln!("skipped: no symbolic link ({e})");
            return;
        }
        assert_eq!(s.agents.connect(&s.store, &r.id).await, Ok(true));
        assert!(path.is_symlink());
        let written = std::fs::read_to_string(linked.join("codex.toml")).unwrap();
        assert!(written.starts_with("a = 1\n") && written.contains(&r.token), "{written}");
        assert_eq!(std::fs::read_dir(&linked).unwrap().count(), 1, "nothing is left beside it");

        std::fs::remove_file(linked.join("codex.toml")).unwrap();
        assert!(s.agents.connect(&s.store, &r.id).await.unwrap_err().contains("mcp.agentFailed"), "a link that leads nowhere stays");
        assert!(path.is_symlink());
    }

    #[test]
    fn a_file_changed_since_it_was_read_is_not_overwritten() {
        let s = Sandbox::new("codex-meanwhile");
        let path = s.dir.join("config.toml");
        for (there, read) in [("theirs", Some(&b"ours"[..])), ("theirs", None)] {
            s.set("config.toml", there);
            assert!(overwrite(&path, read, "new").is_err());
            assert_eq!(s.file("config.toml"), there);
        }
        std::fs::remove_file(&path).unwrap();
        assert!(overwrite(&path, Some(b"ours"), "new").is_err());
        assert_eq!(std::fs::read_dir(&s.dir).unwrap().count(), 0, "neither the file nor the part of it");
        overwrite(&path, None, "new").unwrap();
        overwrite(&path, Some(b"new"), "newer").unwrap();
        assert_eq!(s.file("config.toml"), "newer");
    }

    #[tokio::test]
    async fn the_installed_codex_reads_what_is_written() {
        let s = Sandbox::new("codex");
        s.set("config.toml", "# my notes\nmodel = \"x\" # keep\n\n[mcp_servers.other]\ncommand = \"foo\" # other\n");
        let r = s.register(Target::Codex);
        assert_eq!(s.agents.connect(&s.store, &r.id).await, Ok(true));
        let listed =
            Command::new("codex").args(["mcp", "list", "--json"]).current_dir(&s.dir).env("CODEX_HOME", &s.dir).env("CLAUDE_CONFIG_DIR", &s.dir).output().await;
        let listed = match listed {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return eprintln!("skipped: {e}"),
            listed => listed.unwrap(),
        };
        let servers: Value = serde_json::from_slice(&listed.stdout).unwrap_or_else(|e| panic!("{e}: {listed:?}"));
        let ours = servers.as_array().unwrap().iter().find(|server| server["name"] == CLIENT_NAME).unwrap();
        assert_eq!(ours["transport"]["url"], URL, "{ours}");
        assert_eq!(ours["transport"]["http_headers"], json!({ "Authorization": format!("Bearer {}", r.token) }), "{ours}");
        assert!(servers.as_array().unwrap().iter().any(|server| server["name"] == "other"));
    }
}
