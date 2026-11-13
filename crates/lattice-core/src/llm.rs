//! Provider boundary. Domain code builds prompts and validates results; adapters
//! (`claude.rs`, `codex.rs`, `openai.rs`, `gemini.rs`, `anthropic.rs`) only move JSON in and out; `chain.rs`
//! falls back across them.

use std::future::Future;

use serde_json::Value;
use ts_rs::TS;

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
    /// Declined this input (a refusal, a safety block, HTTP 400). The provider is fine for other text.
    #[error("provider declined: {0}")]
    Declined(String),
    /// From `complete_json_now`: usable again after this long.
    #[error("rate limited for {0:.0?}")]
    RateLimited(std::time::Duration),
}

impl LlmError {
    /// For a job's error and the UI: a coded message (`msg!`) as it is, so the UI can translate it.
    pub fn message(&self) -> String {
        match self {
            Self::Unavailable(m) | Self::Failed(m) | Self::Malformed(m) | Self::Declined(m) if m.starts_with(r#"{"code":"#) => m.clone(),
            other => other.to_string(),
        }
    }
}

/// Ends `child`, and what it starts, with this process however this process ends. `kill_on_drop` is
/// not enough: it is a destructor, the app leaves through `std::process::exit`, and Windows lets a
/// process's children outlive it, so a call in flight would go on using the user's quota with nowhere
/// to send its answer. The children go in a job, not the app: an installer or a restart must outlive it.
#[cfg(windows)]
#[allow(unsafe_code, reason = "Windows job object calls")]
pub fn end_with_this_process(child: &tokio::process::Child) {
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectExtendedLimitInformation, SetInformationJobObject,
    };
    // Never closed: the handle's end with the process is what ends the job. Null when it could not be set up.
    static JOB: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    let job = *JOB.get_or_init(|| {
        // SAFETY: null attributes and name are allowed; a zeroed limit struct is valid, and it outlives the call that reads its size.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let size = size_of_val(&limits) as u32;
            if job.is_null() || SetInformationJobObject(job, JobObjectExtendedLimitInformation, (&raw const limits).cast(), size) == 0 {
                log::warn!("no job object for CLI calls: {}", std::io::Error::last_os_error());
                return 0;
            }
            job as usize
        }
    });
    if let Some(process) = child.raw_handle()
        && job != 0
        // SAFETY: `job` lives as long as this process, and `process` while `child` is borrowed.
        && unsafe { AssignProcessToJobObject(job as _, process as _) } == 0
    {
        log::warn!("adding a CLI call to the job object: {}", std::io::Error::last_os_error());
    }
}

/// A CLI provider that could not be started; not installed (or not on PATH) is the usual case.
pub(crate) fn spawn_error(program: &str, e: &std::io::Error) -> LlmError {
    if e.kind() == std::io::ErrorKind::NotFound {
        LlmError::Unavailable(format!("{program}: not found. Install it (and sign in), or remove this step from the AI provider chain"))
    } else {
        LlmError::Unavailable(format!("{program}: {e}"))
    }
}

/// Reasoning effort of one chain entry; each provider accepts a subset (`ProviderKind::efforts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
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

    /// `complete_json` for a caller with somewhere else to go: a provider that would sit out a rate
    /// limit returns `RateLimited` instead.
    fn complete_json_now(&self, system: &str, input: &str, schema: &Value) -> impl Future<Output = Result<Completion, LlmError>> + Send {
        self.complete_json(system, input, schema)
    }
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
        400 => LlmError::Declined(msg),
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

    #[test]
    fn a_coded_message_reaches_the_ui_without_the_kind_before_it() {
        let coded = crate::msg!("translate.localUnavailable", url = "http://127.0.0.1:8077", detail = "refused");
        assert_eq!(LlmError::Unavailable(coded.clone()).message(), coded);
        assert_eq!(LlmError::Failed("HTTP 500: full".into()).message(), "provider failed: HTTP 500: full");
    }
}
