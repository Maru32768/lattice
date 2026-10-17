//! Gemini API adapter (`generateContent` with a response JSON schema), no tools.

use serde_json::{Value, json};

use crate::llm::{Completion, LlmError, LlmProvider, api_client, post_json};

const BASE: &str = "https://generativelanguage.googleapis.com/v1beta/models";
pub const DEFAULT_MODEL: &str = "gemini-flash-latest";

pub struct Gemini {
    pub key: Option<String>,
    pub model: Option<String>,
    http: reqwest::Client,
}

impl Gemini {
    pub fn new(key: Option<String>, model: Option<String>) -> Self {
        Self { key, model, http: api_client() }
    }

    fn url(&self) -> String {
        // Model ids come from settings; keep them out of the path syntax.
        let model: String = self.model.as_deref().unwrap_or(DEFAULT_MODEL).chars().filter(|c| c.is_ascii_alphanumeric() || "-._".contains(*c)).collect();
        format!("{BASE}/{model}:generateContent")
    }
}

fn body(system: &str, input: &str, schema: &Value) -> Value {
    json!({
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": input}]}],
        "generationConfig": {"responseMimeType": "application/json", "responseJsonSchema": schema},
    })
}

fn parse_completion(v: &Value) -> Result<Completion, LlmError> {
    let cand = &v["candidates"][0];
    let text: String = cand["content"]["parts"].as_array().into_iter().flatten().filter_map(|p| p["text"].as_str()).collect();
    if text.is_empty() {
        let why = v["promptFeedback"]["blockReason"].as_str().or(cand["finishReason"].as_str()).unwrap_or("no candidates");
        return Err(LlmError::Malformed(why.to_string()));
    }
    let value: Value = serde_json::from_str(&text).map_err(|e| LlmError::Malformed(e.to_string()))?;
    Ok(Completion { value, model: v["modelVersion"].as_str().map(str::to_string), provider: "gemini-api".into() })
}

impl LlmProvider for Gemini {
    fn name(&self) -> &str {
        "gemini-api"
    }

    async fn complete_json(&self, system: &str, input: &str, schema: &Value) -> Result<Completion, LlmError> {
        let key = self.key.as_deref().filter(|k| !k.is_empty()).ok_or_else(|| LlmError::Unavailable("Gemini API key is not set".into()))?;
        let v = post_json(self.http.post(self.url()).header("x-goog-api-key", key), &body(system, input, schema)).await?;
        parse_completion(&v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_request_and_parses_response() {
        assert!(Gemini::new(None, None).url().ends_with("/gemini-flash-latest:generateContent"));
        assert!(Gemini::new(None, Some("../x?k=1".into())).url().ends_with("/..xk1:generateContent"));
        let b = body("sys", "text", &json!({"type": "object"}));
        assert_eq!(b["systemInstruction"]["parts"][0]["text"], "sys");
        assert_eq!(b["generationConfig"]["responseJsonSchema"]["type"], "object");

        let v = json!({"modelVersion": "gemini-3-flash", "candidates": [{"content": {"parts": [{"text": "{\"summary\":"}, {"text": "\"s\"}"}]}, "finishReason": "STOP"}]});
        let c = parse_completion(&v).unwrap();
        assert_eq!((c.value["summary"].as_str(), c.model.as_deref()), (Some("s"), Some("gemini-3-flash")));
        let blocked = json!({"promptFeedback": {"blockReason": "SAFETY"}});
        assert!(matches!(parse_completion(&blocked), Err(LlmError::Malformed(m)) if m == "SAFETY"));
    }
}
