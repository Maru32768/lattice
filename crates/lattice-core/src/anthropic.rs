//! Anthropic Messages API adapter with structured outputs (`output_config.format` JSON
//! schema), no tools.

use serde_json::{Value, json};

use crate::llm::{Completion, LlmError, LlmProvider, api_client, post_json, strict_schema};

const URL: &str = "https://api.anthropic.com/v1/messages";
const VERSION: &str = "2023-06-01";
pub const DEFAULT_MODEL: &str = "claude-opus-5-5";
/// Non-streaming ceiling: a translation batch (≤6000 chars, units plus translations) fits well inside.
const MAX_TOKENS: u32 = 16000;

pub struct Anthropic {
    pub key: Option<String>,
    pub model: Option<String>,
    http: reqwest::Client,
}

impl Anthropic {
    pub fn new(key: Option<String>, model: Option<String>) -> Self {
        Self { key, model, http: api_client() }
    }

    fn body(&self, system: &str, input: &str, schema: &Value) -> Value {
        json!({
            "model": self.model.as_deref().unwrap_or(DEFAULT_MODEL),
            "max_tokens": MAX_TOKENS,
            "system": system,
            "messages": [{"role": "user", "content": input}],
            "output_config": {"format": {"type": "json_schema", "schema": strict_schema(schema)}},
        })
    }
}

fn parse_completion(v: &Value) -> Result<Completion, LlmError> {
    match v["stop_reason"].as_str() {
        Some("refusal") => return Err(LlmError::Failed(format!("refused: {}", v["stop_details"]["category"].as_str().unwrap_or("")))),
        Some("max_tokens") => return Err(LlmError::Malformed("max_tokens".into())),
        _ => {}
    }
    // Thinking blocks may precede the answer; only text blocks carry the JSON.
    let text: String = v["content"].as_array().into_iter().flatten().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect();
    if text.is_empty() {
        return Err(LlmError::Malformed(v["stop_reason"].as_str().unwrap_or("no text").to_string()));
    }
    let value: Value = serde_json::from_str(&text).map_err(|e| LlmError::Malformed(e.to_string()))?;
    Ok(Completion { value, model: v["model"].as_str().map(str::to_string), provider: "anthropic-api".into() })
}

impl LlmProvider for Anthropic {
    fn name(&self) -> &str {
        "anthropic-api"
    }

    async fn complete_json(&self, system: &str, input: &str, schema: &Value) -> Result<Completion, LlmError> {
        let key = self.key.as_deref().filter(|k| !k.is_empty()).ok_or_else(|| LlmError::Unavailable("Anthropic API key is not set".into()))?;
        let req = self.http.post(URL).header("x-api-key", key).header("anthropic-version", VERSION);
        let v = post_json(req, &self.body(system, input, schema)).await?;
        parse_completion(&v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_request_and_parses_response() {
        let b = Anthropic::new(None, None).body("sys", "text", &crate::segments::schema());
        assert_eq!((b["model"].as_str(), b["system"].as_str()), (Some(DEFAULT_MODEL), Some("sys")));
        assert_eq!(b["messages"], json!([{"role": "user", "content": "text"}]));
        assert_eq!(b["output_config"]["format"]["type"], "json_schema");
        assert_eq!(b["output_config"]["format"]["schema"]["additionalProperties"], false);
        assert!(b.get("tools").is_none(), "untrusted input gets no tools");
        assert_eq!(Anthropic::new(None, Some("claude-haiku-5-5".into())).body("", "", &json!({}))["model"], "claude-haiku-5-5");

        let v = json!({"model": "claude-opus-5-5", "stop_reason": "end_turn", "content": [
            {"type": "thinking", "thinking": "", "signature": "x"},
            {"type": "text", "text": "{\"summary\":\"s\",\"key_points\":[]}"}
        ]});
        let c = parse_completion(&v).unwrap();
        assert_eq!((c.value["summary"].as_str(), c.model.as_deref(), c.provider.as_str()), (Some("s"), Some("claude-opus-5-5"), "anthropic-api"));
        let refused = json!({"stop_reason": "refusal", "stop_details": {"type": "refusal", "category": "cyber"}, "content": []});
        assert!(matches!(parse_completion(&refused), Err(LlmError::Failed(m)) if m.contains("cyber")));
        let cut = json!({"stop_reason": "max_tokens", "content": [{"type": "text", "text": "{\"summ"}]});
        assert!(matches!(parse_completion(&cut), Err(LlmError::Malformed(m)) if m == "max_tokens"));
    }

    #[tokio::test]
    async fn missing_key_is_unavailable() {
        let e = Anthropic::new(Some(String::new()), None).complete_json("s", "i", &json!({})).await.unwrap_err();
        assert!(matches!(e, LlmError::Unavailable(_)));
    }
}
