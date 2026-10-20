//! Provider boundary. Domain code builds prompts and validates results; adapters
//! (`claude.rs`, `codex.rs`, `openai.rs`, `gemini.rs`, `anthropic.rs`) only move JSON in and out; `chain.rs`
//! falls back across them.

use std::future::Future;

use serde_json::Value;

#[derive(Debug, Clone)]
pub struct Completion {
    /// Output conforming to the requested JSON schema.
    pub value: Value,
    /// Model that actually answered, when the provider reports it.
    pub model: Option<String>,
    /// `name()` of the provider that answered (differs from the caller's provider behind a chain).
    pub provider: String,
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

/// Reasoning effort of one chain entry; each provider accepts a subset (`ProviderKind::efforts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Effort {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl Effort {
    /// The value every provider's API and CLI takes.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
        }
    }
}

pub trait LlmProvider: Send + Sync + 'static {
    /// Stable identifier recorded with derived data, e.g. "claude-cli".
    fn name(&self) -> &str;

    /// One structured completion: `system` instructions, untrusted `input`, output per `schema`.
    fn complete_json(&self, system: &str, input: &str, schema: &Value) -> impl Future<Output = Result<Completion, LlmError>> + Send;
}

/// OpenAI structured outputs (and Codex `--output-schema`) need `additionalProperties: false`
/// on every object; our schemas already list every property as required.
pub fn strict_schema(schema: &Value) -> Value {
    match schema {
        Value::Object(m) => {
            let mut out: serde_json::Map<String, Value> = m.iter().map(|(k, v)| (k.clone(), strict_schema(v))).collect();
            if m.get("type").and_then(Value::as_str) == Some("object") {
                out.insert("additionalProperties".into(), Value::Bool(false));
            }
            Value::Object(out)
        }
        Value::Array(a) => Value::Array(a.iter().map(strict_schema).collect()),
        other => other.clone(),
    }
}

/// Sends an API request; rate limits, overload (Anthropic 529) and auth problems become
/// `Unavailable` so a chain moves on.
pub(crate) async fn post_json(req: reqwest::RequestBuilder, body: &Value) -> Result<Value, LlmError> {
    let req = req.header(reqwest::header::CONTENT_TYPE, "application/json").body(body.to_string());
    let resp = req.send().await.map_err(|e| LlmError::Failed(format!("request failed: {e}")))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| LlmError::Failed(e.to_string()))?;
    let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    if status.is_success() {
        return Ok(v);
    }
    let msg = v["error"]["message"].as_str().map(str::to_string).unwrap_or_else(|| body.chars().take(300).collect());
    let msg = format!("HTTP {status}: {msg}");
    Err(match status.as_u16() {
        401 | 403 | 429 | 529 => LlmError::Unavailable(msg),
        _ => LlmError::Failed(msg),
    })
}

/// Shared client for LLM APIs: a long translation batch can take minutes.
pub(crate) fn api_client() -> reqwest::Client {
    reqwest::Client::builder().timeout(std::time::Duration::from_secs(600)).build().expect("static client config")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_schema_closes_objects() {
        let s = strict_schema(&crate::segments::schema());
        assert_eq!(s["additionalProperties"], false);
        assert_eq!(s["properties"]["blocks"]["items"]["properties"]["sentences"]["items"]["additionalProperties"], false);
        assert!(s["properties"]["blocks"].get("additionalProperties").is_none(), "arrays untouched");
    }
}
