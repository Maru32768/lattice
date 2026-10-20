//! Fallback chain (F3): up to three (provider, model) entries tried in order. An entry that
//! just failed is tried last for a while, so a usage-limited CLI is not hit on every call.
//! The chain is swappable at runtime; the job runners share one instance.

use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::anthropic::Anthropic;
use crate::claude::ClaudeCli;
use crate::codex::CodexCli;
use crate::gemini::Gemini;
use crate::llm::{Completion, Effort, LlmError, LlmProvider};
use crate::msg;
use crate::openai::OpenAi;
use crate::store::{SECRET_PREFIX, Store};

pub const CHAIN_SETTING: &str = "llm_chain";
/// Single-model setting from before the chain; becomes the first entry until the chain is saved.
const LEGACY_MODEL_SETTING: &str = "claude_model";
pub const MAX_ENTRIES: usize = 3;
const COOLDOWN: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    ClaudeCli,
    CodexCli,
    Openai,
    Gemini,
    Anthropic,
}

impl ProviderKind {
    /// (settings key, env var) of the API key, for API providers.
    pub fn key_names(self) -> Option<(String, &'static str)> {
        match self {
            Self::Openai => Some((format!("{SECRET_PREFIX}openai_api_key"), "OPENAI_API_KEY")),
            Self::Gemini => Some((format!("{SECRET_PREFIX}gemini_api_key"), "GEMINI_API_KEY")),
            Self::Anthropic => Some((format!("{SECRET_PREFIX}anthropic_api_key"), "ANTHROPIC_API_KEY")),
            Self::ClaudeCli | Self::CodexCli => None,
        }
    }

    /// Reasoning efforts the provider accepts: Claude `--effort`, Codex `model_reasoning_effort`,
    /// OpenAI `reasoning.effort`, Anthropic `output_config.effort`, Gemini `thinkingLevel`.
    pub fn efforts(self) -> &'static [Effort] {
        use Effort::*;
        match self {
            Self::Gemini => &[Low, Medium, High],
            Self::ClaudeCli | Self::CodexCli | Self::Openai | Self::Anthropic => &[Low, Medium, High, Xhigh, Max],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChainEntry {
    pub kind: ProviderKind,
    /// None uses the provider's default model.
    pub model: Option<String>,
    /// None uses the provider's (or model's) default. Absent in chains saved before efforts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<Effort>,
}

pub fn load_config(store: &Store) -> Result<Vec<ChainEntry>, String> {
    let saved = store.setting(CHAIN_SETTING).map_err(|e| e.to_string())?;
    if let Some(entries) = saved.and_then(|s| serde_json::from_str::<Vec<ChainEntry>>(&s).ok()).filter(|e| !e.is_empty()) {
        return Ok(entries);
    }
    let model = store.setting(LEGACY_MODEL_SETTING).map_err(|e| e.to_string())?;
    Ok(vec![ChainEntry { kind: ProviderKind::ClaudeCli, model, effort: None }])
}

/// Validates and stores the chain; returns it normalized (trimmed models, empty = default).
pub fn save_config(store: &Store, entries: Vec<ChainEntry>) -> Result<Vec<ChainEntry>, String> {
    if entries.is_empty() || entries.len() > MAX_ENTRIES {
        return Err(msg!("chain.entries", max = MAX_ENTRIES));
    }
    for (i, e) in entries.iter().enumerate() {
        if let Some(x) = e.effort.filter(|x| !e.kind.efforts().contains(x)) {
            return Err(msg!("chain.effortUnsupported", step = i + 1, effort = x.as_str()));
        }
    }
    let entries: Vec<ChainEntry> =
        entries.into_iter().map(|e| ChainEntry { model: e.model.map(|m| m.trim().to_string()).filter(|m| !m.is_empty()), ..e }).collect();
    let json = serde_json::to_string(&entries).map_err(|e| e.to_string())?;
    store.set_setting(CHAIN_SETTING, Some(&json)).map_err(|e| e.to_string())?;
    Ok(entries)
}

/// API key from settings, else the environment. Returns the key and where it came from.
pub fn api_key(store: &Store, kind: ProviderKind) -> Result<Option<(String, &'static str)>, String> {
    let Some((setting, env)) = kind.key_names() else { return Ok(None) };
    if let Some(k) = store.setting(&setting).map_err(|e| e.to_string())?.filter(|k| !k.is_empty()) {
        return Ok(Some((k, "stored")));
    }
    Ok(std::env::var(env).ok().filter(|k| !k.trim().is_empty()).map(|k| (k, "env")))
}

pub fn set_api_key(store: &Store, kind: ProviderKind, key: Option<&str>) -> Result<(), String> {
    let (setting, _) = kind.key_names().ok_or_else(|| msg!("chain.noApiKey"))?;
    store.set_setting(&setting, key.map(str::trim).filter(|k| !k.is_empty())).map_err(|e| e.to_string())
}

/// Any configured provider; an enum because `LlmProvider` is not object-safe.
pub enum AnyLlm {
    Claude(ClaudeCli),
    Codex(CodexCli),
    OpenAi(OpenAi),
    Gemini(Gemini),
    Anthropic(Anthropic),
}

impl LlmProvider for AnyLlm {
    fn name(&self) -> &str {
        match self {
            Self::Claude(p) => p.name(),
            Self::Codex(p) => p.name(),
            Self::OpenAi(p) => p.name(),
            Self::Gemini(p) => p.name(),
            Self::Anthropic(p) => p.name(),
        }
    }

    async fn complete_json(&self, system: &str, input: &str, schema: &Value) -> Result<Completion, LlmError> {
        match self {
            Self::Claude(p) => p.complete_json(system, input, schema).await,
            Self::Codex(p) => p.complete_json(system, input, schema).await,
            Self::OpenAi(p) => p.complete_json(system, input, schema).await,
            Self::Gemini(p) => p.complete_json(system, input, schema).await,
            Self::Anthropic(p) => p.complete_json(system, input, schema).await,
        }
    }
}

/// Builds the providers for the stored chain, with API keys resolved now.
pub fn load(store: &Store) -> Result<Vec<(AnyLlm, Option<String>)>, String> {
    load_config(store)?
        .into_iter()
        .map(|e| {
            let key = api_key(store, e.kind)?.map(|(k, _)| k);
            let (model, effort) = (e.model.clone(), e.effort);
            let llm = match e.kind {
                ProviderKind::ClaudeCli => {
                    let mut c = ClaudeCli::default();
                    c.effort = effort;
                    c.set_model(model.clone());
                    AnyLlm::Claude(c)
                }
                ProviderKind::CodexCli => AnyLlm::Codex(CodexCli { model: model.clone(), effort, ..CodexCli::default() }),
                ProviderKind::Openai => AnyLlm::OpenAi(OpenAi::new(key, model.clone(), effort)),
                ProviderKind::Gemini => AnyLlm::Gemini(Gemini::new(key, model.clone(), effort)),
                ProviderKind::Anthropic => AnyLlm::Anthropic(Anthropic::new(key, model.clone(), effort)),
            };
            Ok((llm, model))
        })
        .collect()
}

struct Slot<P> {
    llm: P,
    model: Option<String>,
    failed_at: Mutex<Option<Instant>>,
}

pub struct LlmChain<P = AnyLlm> {
    slots: RwLock<Arc<Vec<Slot<P>>>>,
}

impl<P> LlmChain<P> {
    pub fn new(entries: Vec<(P, Option<String>)>) -> Self {
        let chain = Self { slots: RwLock::new(Arc::new(Vec::new())) };
        chain.set(entries);
        chain
    }

    /// Replaces the chain; calls already in flight finish on the old one.
    pub fn set(&self, entries: Vec<(P, Option<String>)>) {
        let slots = entries.into_iter().map(|(llm, model)| Slot { llm, model, failed_at: Mutex::new(None) }).collect();
        *self.slots.write().unwrap_or_else(|e| e.into_inner()) = Arc::new(slots);
    }
}

impl<P: LlmProvider> LlmProvider for LlmChain<P> {
    fn name(&self) -> &str {
        "chain"
    }

    async fn complete_json(&self, system: &str, input: &str, schema: &Value) -> Result<Completion, LlmError> {
        let slots = self.slots.read().unwrap_or_else(|e| e.into_inner()).clone();
        let cooling = |s: &Slot<P>| s.failed_at.lock().unwrap_or_else(|e| e.into_inner()).is_some_and(|t| t.elapsed() < COOLDOWN);
        let mut order: Vec<&Slot<P>> = slots.iter().collect();
        order.sort_by_key(|s| cooling(s)); // stable: configured order within each group
        let mut errors = Vec::new();
        for s in order {
            match s.llm.complete_json(system, input, schema).await {
                Ok(mut c) => {
                    *s.failed_at.lock().unwrap_or_else(|e| e.into_inner()) = None;
                    c.model = c.model.or_else(|| s.model.clone());
                    return Ok(c);
                }
                Err(e) => {
                    log::warn!("{} ({}) failed: {e}", s.llm.name(), s.model.as_deref().unwrap_or("default"));
                    // Malformed output is usually a one-off; limits, auth and timeouts persist.
                    if !matches!(e, LlmError::Malformed(_)) {
                        *s.failed_at.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
                    }
                    errors.push(e);
                }
            }
        }
        match errors.len() {
            0 => Err(LlmError::Unavailable("no model configured".into())),
            1 => Err(errors.pop().expect("one error")),
            _ => Err(LlmError::Failed(errors.iter().map(ToString::to_string).collect::<Vec<_>>().join(" / "))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::segments::tests::Fake;

    #[tokio::test]
    async fn falls_back_and_cools_down_failed_entry() {
        let chain = LlmChain::new(vec![(Fake { fail: true, ..Fake::new() }, Some("a".into())), (Fake::new(), Some("b".into()))]);
        let schema = serde_json::json!({});
        let input = r#"[{"i":0,"html":"x"}]"#;
        let c = chain.complete_json("translate", input, &schema).await.unwrap();
        assert_eq!(c.model.as_deref(), Some("fake-1"), "answered by the second entry");
        chain.complete_json("translate", input, &schema).await.unwrap();
        let slots = chain.slots.read().unwrap().clone();
        assert_eq!((slots[0].llm.calls.lock().unwrap().len(), slots[1].llm.calls.lock().unwrap().len()), (1, 2), "failed entry skipped while cooling");

        let all_fail = LlmChain::new(vec![(Fake { fail: true, ..Fake::new() }, None), (Fake { fail: true, ..Fake::new() }, None)]);
        let e = all_fail.complete_json("translate", input, &schema).await.unwrap_err().to_string();
        assert_eq!(e.matches("usage limit").count(), 2, "{e}");
        // Summary Fake reports no model: the configured one is recorded.
        let c = LlmChain::new(vec![(Fake::new(), Some("cfg".into()))]).complete_json("You summarize technical articles", "", &schema).await.unwrap();
        assert_eq!((c.model.as_deref(), c.provider.as_str()), (Some("cfg"), "fake"));
    }

    #[test]
    fn config_migrates_legacy_model_and_keys() {
        let s = Store::open_in_memory().unwrap();
        s.set_setting(LEGACY_MODEL_SETTING, Some("sonnet")).unwrap();
        assert_eq!(load_config(&s).unwrap(), vec![ChainEntry { kind: ProviderKind::ClaudeCli, model: Some("sonnet".into()), effort: None }]);
        let saved = save_config(
            &s,
            vec![
                ChainEntry { kind: ProviderKind::CodexCli, model: Some("  ".into()), effort: Some(Effort::Max) },
                ChainEntry { kind: ProviderKind::Gemini, model: Some(" gemini-pro-latest ".into()), effort: None },
            ],
        )
        .unwrap();
        assert_eq!(saved[0].model, None);
        assert_eq!(load_config(&s).unwrap(), saved);
        let json = s.setting(CHAIN_SETTING).unwrap().unwrap();
        assert!(json.contains(r#""effort":"max""#) && json.matches("effort").count() == 1, "default effort is not stored: {json}");
        assert!(save_config(&s, vec![ChainEntry { kind: ProviderKind::Gemini, model: None, effort: Some(Effort::Xhigh) }]).is_err(), "Gemini has no xhigh");

        // Chains saved before efforts existed still load, with the default effort.
        s.set_setting(CHAIN_SETTING, Some(r#"[{"kind":"openai","model":null}]"#)).unwrap();
        assert_eq!(load_config(&s).unwrap(), vec![ChainEntry { kind: ProviderKind::Openai, model: None, effort: None }]);
        save_config(&s, saved.clone()).unwrap();
        assert!(save_config(&s, vec![]).is_err());
        assert!(save_config(&s, vec![saved[0].clone(); 4]).is_err());

        set_api_key(&s, ProviderKind::Gemini, Some(" k ")).unwrap();
        assert_eq!(api_key(&s, ProviderKind::Gemini).unwrap(), Some(("k".into(), "stored")));
        assert!(s.setting("secret.gemini_api_key").unwrap().is_some(), "stored as a secret so backups drop it");
        assert!(set_api_key(&s, ProviderKind::ClaudeCli, Some("x")).is_err());
        set_api_key(&s, ProviderKind::Anthropic, Some("a")).unwrap();
        assert!(s.setting("secret.anthropic_api_key").unwrap().is_some());
        assert_eq!(serde_json::to_string(&ProviderKind::Anthropic).unwrap(), "\"anthropic\"");
        assert_eq!(load(&s).unwrap().len(), 2);
    }
}
