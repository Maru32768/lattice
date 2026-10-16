//! Provider boundary. Domain code sees only these types; CLI/API specifics live in adapters
//! (`claude.rs`). Methods are added per capability as slices need them (summarize, classify...).

use std::future::Future;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Item {
    pub id: i64,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct Output {
    pub items: Vec<Item>,
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

    /// Translate each item's text into `target_language` (BCP 47), preserving `backticked` code.
    fn translate(&self, items: &[Item], target_language: &str) -> impl Future<Output = Result<Output, LlmError>> + Send;
}
