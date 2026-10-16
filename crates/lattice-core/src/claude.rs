//! Claude Code CLI adapter (`claude -p`). Uses the user's existing CLI login; no API key needed.
//!
//! Article text is untrusted, so the agent runs with every tool, MCP server and settings
//! source disabled, from an empty working directory: a prompt injection can at worst
//! produce a bad translation.

use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::llm::{Completion, LlmError, LlmProvider};

pub struct ClaudeCli {
    pub program: String,
    pub model: Option<String>,
    pub timeout: Duration,
}

impl Default for ClaudeCli {
    fn default() -> Self {
        Self { program: "claude".into(), model: None, timeout: Duration::from_secs(600) }
    }
}

impl ClaudeCli {
    async fn run(&self, system: &str, input: &str, schema: &Value) -> Result<Value, LlmError> {
        let mut cmd = Command::new(&self.program);
        cmd.args(["-p", "--output-format", "json", "--no-session-persistence", "--strict-mcp-config"])
            .args(["--tools", "", "--setting-sources", ""])
            .args(["--system-prompt", system, "--json-schema", &schema.to_string()]);
        if let Some(m) = &self.model {
            cmd.args(["--model", m]);
        }
        cmd.current_dir(std::env::temp_dir())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flash from the GUI app

        let mut child = cmd.spawn().map_err(|e| LlmError::Unavailable(format!("{}: {e}", self.program)))?;
        let mut stdin = child.stdin.take().expect("stdin piped");
        stdin.write_all(input.as_bytes()).await.map_err(|e| LlmError::Failed(e.to_string()))?;
        drop(stdin);

        let out = tokio::time::timeout(self.timeout, child.wait_with_output())
            .await
            .map_err(|_| LlmError::Failed(format!("timed out after {:?}", self.timeout)))?
            .map_err(|e| LlmError::Failed(e.to_string()))?;
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
    Ok(Completion { value, model })
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
}
