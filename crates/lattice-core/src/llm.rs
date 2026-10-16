//! Provider boundary. Domain code builds prompts and validates results; adapters
//! (`claude.rs`, later Codex / API providers) only move JSON in and out.

use std::future::Future;

use serde_json::Value;

#[derive(Debug, Clone)]
pub struct Completion {
    /// Output conforming to the requested JSON schema.
    pub value: Value,
    /// Model that actually answered, when the provider reports it.
    pub model: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum LlmError {
    #[error("provider unavailable: {0}")]
    Unavailable(String),
    #[error("provider failed: {0}")]
    Failed(String),
    #[error("malformed provider output: {0}")]
    Malformed(String),
}

pub trait LlmProvider: Send + Sync + 'static {
    /// Stable identifier recorded with derived data, e.g. "claude-cli".
    fn name(&self) -> &str;

    /// One structured completion: `system` instructions, untrusted `input`, output per `schema`.
    fn complete_json(&self, system: &str, input: &str, schema: &Value) -> impl Future<Output = Result<Completion, LlmError>> + Send;
}
