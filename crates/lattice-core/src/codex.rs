//! Codex CLI adapter (`codex exec`). Uses the user's existing Codex login; no API key needed.
//!
//! Same stance as `claude.rs`: article text is untrusted, so the agent runs with user config,
//! rules, web search and every tool feature disabled, read-only, from an empty directory, and
//! without saving the session.

use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::llm::{Completion, LlmError, LlmProvider, strict_schema};

/// Features that give the agent tools; all off so page text cannot drive anything.
const DISABLED_FEATURES: &[&str] = &[
    "shell_tool", "unified_exec", "apps", "plugins", "multi_agent", "image_generation", "hooks",
    "browser_use", "computer_use", "view_image", "skill_search", "goals", "tool_suggest",
];

pub struct CodexCli {
    pub program: String,
    /// `--model` value; None uses the CLI's default.
    pub model: Option<String>,
    pub timeout: Duration,
}

impl Default for CodexCli {
    fn default() -> Self {
        Self { program: "codex".into(), model: None, timeout: Duration::from_secs(600) }
    }
}

impl CodexCli {
    async fn run(&self, system: &str, input: &str, schema: &Value) -> Result<String, LlmError> {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let tmp = std::env::temp_dir();
        let cwd = tmp.join("lattice-codex");
        std::fs::create_dir_all(&cwd).map_err(|e| LlmError::Failed(e.to_string()))?;
        // The schema file lives outside the (empty) working directory.
        let schema_path = tmp.join(format!("lattice-codex-schema-{}-{}.json", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
        std::fs::write(&schema_path, strict_schema(schema).to_string()).map_err(|e| LlmError::Failed(e.to_string()))?;

        let mut cmd = Command::new(&self.program);
        cmd.args(["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules"])
            .args(["--sandbox", "read-only", "--color", "never", "-c", "web_search=disabled", "-c", "model_reasoning_effort=low"])
            .arg("-C")
            .arg(&cwd)
            .arg("--output-schema")
            .arg(&schema_path);
        for f in DISABLED_FEATURES {
            cmd.args(["--disable", f]);
        }
        if let Some(m) = &self.model {
            cmd.args(["--model", m]);
        }
        // Instructions as the prompt; the untrusted text arrives on stdin as a <stdin> block.
        cmd.arg(system)
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

        let result = async {
            let mut child = cmd.spawn().map_err(|e| LlmError::Unavailable(format!("{}: {e}", self.program)))?;
            let mut stdin = child.stdin.take().expect("stdin piped");
            stdin.write_all(input.as_bytes()).await.map_err(|e| LlmError::Failed(e.to_string()))?;
            drop(stdin);
            tokio::time::timeout(self.timeout, child.wait_with_output())
                .await
                .map_err(|_| LlmError::Failed(format!("timed out after {:?}", self.timeout)))?
                .map_err(|e| LlmError::Failed(e.to_string()))
        }
        .await;
        let _ = std::fs::remove_file(&schema_path);
        let out = result?;
        let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
        if !out.status.success() && !stdout.contains("\"agent_message\"") {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let msg = event_error(&stdout).or_else(|| stderr.lines().map(str::trim).rfind(|l| !l.is_empty()).map(str::to_string));
            return Err(LlmError::Failed(format!("exit {}: {}", out.status, msg.unwrap_or_default())));
        }
        Ok(stdout)
    }
}

/// Last error reported in `codex exec --json` events (usage limits, auth).
fn event_error(jsonl: &str) -> Option<String> {
    jsonl.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter_map(|v| match v["type"].as_str() {
        Some("turn.failed") => v["error"]["message"].as_str().map(str::to_string),
        Some("error") => v["message"].as_str().map(str::to_string),
        _ => None,
    }).last()
}

/// Parses `codex exec --json` JSONL: the final agent message holds the schema-shaped JSON.
fn parse_completion(jsonl: &str) -> Result<Completion, LlmError> {
    let text = jsonl
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| v["type"] == "item.completed" && v["item"]["type"] == "agent_message")
        .filter_map(|v| v["item"]["text"].as_str().map(str::to_string))
        .last();
    let Some(text) = text else {
        return Err(event_error(jsonl).map(LlmError::Failed).unwrap_or_else(|| LlmError::Malformed("no agent message".into())));
    };
    let value: Value = serde_json::from_str(&text).map_err(|e| LlmError::Malformed(e.to_string()))?;
    if !value.is_object() {
        return Err(LlmError::Malformed("not an object".into()));
    }
    // The CLI does not report the model; the chain fills in the configured one.
    Ok(Completion { value, model: None, provider: "codex-cli".into() })
}

impl LlmProvider for CodexCli {
    fn name(&self) -> &str {
        "codex-cli"
    }

    async fn complete_json(&self, system: &str, input: &str, schema: &Value) -> Result<Completion, LlmError> {
        parse_completion(&self.run(system, input, schema).await?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_exec_events() {
        // Captured from codex-cli 0.162.1 `exec --json --output-schema`.
        let ok = r#"{"type":"thread.started","thread_id":"01a147e4"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\"summary\":\"WALは書き込みを永続化します。\",\"key_points\":[]}"}}
{"type":"turn.completed","usage":{"input_tokens":9516,"output_tokens":44}}"#;
        let c = parse_completion(ok).unwrap();
        assert_eq!(c.value["summary"], "WALは書き込みを永続化します。");
        assert_eq!(c.provider, "codex-cli");

        let failed = r#"{"type":"turn.started"}
{"type":"turn.failed","error":{"message":"You've hit your usage limit."}}"#;
        assert!(matches!(parse_completion(failed), Err(LlmError::Failed(m)) if m.contains("usage limit")));
        let garbage = r#"{"type":"item.completed","item":{"type":"agent_message","text":"not json"}}"#;
        assert!(matches!(parse_completion(garbage), Err(LlmError::Malformed(_))));
    }

    /// Real paid call: `cargo test -p lattice-core codex -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn live_codex_exec() {
        let schema = serde_json::json!({"type": "object", "properties": {"ja": {"type": "string"}}, "required": ["ja"]});
        let c = CodexCli::default().complete_json("Translate the input to Japanese.", "Write-ahead log", &schema).await.unwrap();
        assert!(c.value["ja"].is_string(), "{:?}", c.value);
    }
}
