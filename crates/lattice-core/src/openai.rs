//! OpenAI Responses API adapter with structured outputs (strict JSON schema), no tools.

use serde_json::{Value, json};

use crate::llm::{Completion, LlmError, LlmProvider, api_client, post_json, strict_schema};

const URL: &str = "https://api.openai.com/v1/responses";
pub const DEFAULT_MODEL: &str = "gpt-6-luna";

pub struct OpenAi {
    pub key: Option<String>,
    pub model: Option<String>,
    http: reqwest::Client,
}

impl OpenAi {
    pub fn new(key: Option<String>, model: Option<String>) -> Self {
        Self { key, model, http: api_client() }
    }

    fn body(&self, system: &str, input: &str, schema: &Value) -> Value {
        json!({
            "model": self.model.as_deref().unwrap_or(DEFAULT_MODEL),
            "instructions": system,
            "input": input,
            "store": false,
            "text": {"format": {"type": "json_schema", "name": "output", "strict": true, "schema": strict_schema(schema)}},
        })
    }
}

fn parse_completion(v: &Value) -> Result<Completion, LlmError> {
    let content = v["output"].as_array().into_iter().flatten().filter(|o| o["type"] == "message").flat_map(|o| o["content"].as_array().into_iter().flatten());
    let mut text = None;
    for c in content {
        match c["type"].as_str() {
            Some("output_text") => text = c["text"].as_str(),
            Some("refusal") => return Err(LlmError::Failed(format!("refused: {}", c["refusal"].as_str().unwrap_or("")))),
            _ => {}
        }
    }
    let Some(text) = text else {
        let why = v["incomplete_details"]["reason"].as_str().or(v["status"].as_str()).unwrap_or("no output_text");
        return Err(LlmError::Malformed(why.to_string()));
    };
    let value: Value = serde_json::from_str(text).map_err(|e| LlmError::Malformed(e.to_string()))?;
    Ok(Completion { value, model: v["model"].as_str().map(str::to_string), provider: "openai-api".into() })
}

impl LlmProvider for OpenAi {
    fn name(&self) -> &str {
        "openai-api"
    }

    async fn complete_json(&self, system: &str, input: &str, schema: &Value) -> Result<Completion, LlmError> {
        let key = self.key.as_deref().filter(|k| !k.is_empty()).ok_or_else(|| LlmError::Unavailable("OpenAI API key is not set".into()))?;
        let v = post_json(self.http.post(URL).bearer_auth(key), &self.body(system, input, schema)).await?;
        parse_completion(&v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_request_and_parses_response() {
        let b = OpenAi::new(None, None).body("sys", "text", &crate::segments::schema());
        assert_eq!((b["model"].as_str(), b["instructions"].as_str(), b["input"].as_str()), (Some(DEFAULT_MODEL), Some("sys"), Some("text")));
        assert_eq!(b["text"]["format"]["schema"]["additionalProperties"], false);

        let v = json!({"model": "gpt-6-luna-2026-09-01", "status": "completed", "output": [
            {"type": "reasoning", "summary": []},
            {"type": "message", "content": [{"type": "output_text", "text": "{\"summary\":\"s\",\"key_points\":[]}"}]}
        ]});
        let c = parse_completion(&v).unwrap();
        assert_eq!((c.value["summary"].as_str(), c.model.as_deref()), (Some("s"), Some("gpt-6-luna-2026-09-01")));
        let refused = json!({"output": [{"type": "message", "content": [{"type": "refusal", "refusal": "no"}]}]});
        assert!(matches!(parse_completion(&refused), Err(LlmError::Failed(_))));
        let cut = json!({"status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}, "output": []});
        assert!(matches!(parse_completion(&cut), Err(LlmError::Malformed(m)) if m == "max_output_tokens"));
    }
}
