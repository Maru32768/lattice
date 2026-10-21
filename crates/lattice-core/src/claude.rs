//! Claude Code CLI adapter (`claude -p`). Uses the user's existing CLI login; no API key needed.
//!
//! Article text is untrusted, so the agent runs with every tool, MCP server and settings
//! source disabled, from an empty working directory: a prompt injection can at worst
//! produce a bad translation.

use std::process::Stdio;
use std::sync::RwLock;
use std::time::Duration;

use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::llm::{Completion, Effort, LlmError, LlmProvider};

pub struct ClaudeCli {
    pub program: String,
    /// `--model` value (alias like "sonnet" or a full id); None uses the CLI's default.
    model: RwLock<Option<String>>,
    /// `--effort` value; None uses the CLI's default.
    pub effort: Option<Effort>,
    pub timeout: Duration,
}

impl Default for ClaudeCli {
    fn default() -> Self {
        Self { program: "claude".into(), model: RwLock::new(None), effort: None, timeout: Duration::from_secs(600) }
    }
}

impl ClaudeCli {
    pub fn set_model(&self, model: Option<String>) {
        *self.model.write().unwrap_or_else(|e| e.into_inner()) = model.filter(|m| !m.trim().is_empty());
    }

    pub fn model(&self) -> Option<String> {
        self.model.read().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

impl ClaudeCli {
    fn args(&self, system: &str, schema: &Value) -> Vec<String> {
        let mut args: Vec<String> =
            ["-p", "--output-format", "json", "--no-session-persistence", "--strict-mcp-config", "--tools", "", "--setting-sources", ""]
                .map(String::from)
                .into();
        args.extend(["--system-prompt".into(), system.into(), "--json-schema".into(), schema.to_string()]);
        if let Some(m) = self.model() {
            args.extend(["--model".into(), m]);
        }
        if let Some(e) = self.effort {
            args.extend(["--effort".into(), e.as_str().into()]);
        }
        args
    }

    async fn run(&self, system: &str, input: &str, schema: &Value) -> Result<Value, LlmError> {
        // An empty working directory, like Codex: nothing for the CLI to read or pick up.
        let cwd = std::env::temp_dir().join("lattice-claude");
        std::fs::create_dir_all(&cwd).map_err(|e| LlmError::Failed(e.to_string()))?;
        let mut cmd = Command::new(&self.program);
        cmd.args(self.args(system, schema));
        cmd.current_dir(&cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flash from the GUI app

        let mut child = cmd.spawn().map_err(|e| LlmError::Unavailable(format!("{}: {e}", self.program)))?;
        let mut stdin = child.stdin.take().expect("stdin piped");
        // The write shares the timeout: a CLI that stops reading would otherwise hang the worker.
        let write = async move { stdin.write_all(input.as_bytes()).await };
        let (written, out) = tokio::time::timeout(self.timeout, async { tokio::join!(write, child.wait_with_output()) })
            .await
            .map_err(|_| LlmError::Failed(format!("timed out after {:?}", self.timeout)))?;
        written.map_err(|e| LlmError::Failed(e.to_string()))?;
        let out = out.map_err(|e| LlmError::Failed(e.to_string()))?;
        let stdout = String::from_utf8_lossy(&out.stdout);
        let v: Value = serde_json::from_str(&stdout).map_err(|_| {
            let stderr = String::from_utf8_lossy(&out.stderr);
            LlmError::Failed(format!("exit {}: {}", out.status, first_line(&stderr).or(first_line(&stdout)).unwrap_or("")))
        })?;
        if !out.status.success() || v["is_error"].as_bool() == Some(true) {
            // Usage limits and auth errors arrive here; the job runner backs off and retries.
            return Err(LlmError::Failed(v["result"].as_str().unwrap_or("unknown error").to_string()));
        }
        Ok(v)
    }
}

fn first_line(s: &str) -> Option<&str> {
    s.lines().map(str::trim).find(|l| !l.is_empty())
}

/// Parses `claude -p --output-format json --json-schema` output.
fn parse_completion(v: &Value) -> Result<Completion, LlmError> {
    let value = v.get("structured_output").filter(|o| o.is_object()).cloned().ok_or_else(|| LlmError::Malformed("no structured_output".into()))?;
    let model = v["modelUsage"].as_object().and_then(|m| m.keys().next().cloned());
    Ok(Completion { value, model, provider: "claude-cli".into() })
}

impl LlmProvider for ClaudeCli {
    fn name(&self) -> &str {
        "claude-cli"
    }

    async fn complete_json(&self, system: &str, input: &str, schema: &Value) -> Result<Completion, LlmError> {
        parse_completion(&self.run(system, input, schema).await?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_structured_output() {
        let v: Value = serde_json::from_str(
            r#"{"type":"result","is_error":false,"modelUsage":{"claude-opus-5-5":{}},
                "structured_output":{"blocks":[{"i":0,"sentences":[]}]}}"#,
        )
        .unwrap();
        let out = parse_completion(&v).unwrap();
        assert_eq!(out.value["blocks"][0]["i"], 0);
        assert_eq!(out.model.as_deref(), Some("claude-opus-5-5"));
        assert!(matches!(parse_completion(&serde_json::json!({})), Err(LlmError::Malformed(_))));
    }

    #[test]
    fn passes_model_and_effort_only_when_set() {
        let args = ClaudeCli::default().args("sys", &serde_json::json!({}));
        assert!(args.windows(2).any(|w| w == ["--tools", ""]), "tools stay off");
        assert!(!args.iter().any(|a| a == "--effort" || a == "--model"));
        let c = ClaudeCli { effort: Some(Effort::Xhigh), ..ClaudeCli::default() };
        c.set_model(Some("opus".into()));
        let args = c.args("sys", &serde_json::json!({}));
        assert!(args.windows(2).any(|w| w == ["--effort", "xhigh"]) && args.windows(2).any(|w| w == ["--model", "opus"]), "{args:?}");
    }
}
