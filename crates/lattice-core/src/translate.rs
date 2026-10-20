//! Article translation job: translates an article's prose blocks with the reading-unit
//! algorithm (`segments.rs`), in batches persisted as they return, so a usage limit
//! mid-article loses nothing and a retry only sends what is still missing.

use crate::ir::PROSE_KINDS;
use crate::llm::LlmProvider;
use crate::segments::{self, PROMPT_VERSION, Target, snippet_from_inlines};
use crate::store::{PendingBlock, SegmentRow, Store};

pub const JOB_TYPE: &str = "translate";
pub const TARGET_LANGUAGE: &str = "ja";
/// "off" translates technical terms too; absent means keep them in English (§8).
pub const KEEP_TERMS_SETTING: &str = "translate_keep_terms";
/// The user's extra instructions for the translation prompt; absent means none.
pub const INSTRUCTIONS_SETTING: &str = "translate_instructions";
pub const MAX_INSTRUCTION_CHARS: usize = 2000;
const BATCH_CHARS: usize = 6000;
const BATCH_ITEMS: usize = 12;

pub fn keep_terms(store: &Store) -> Result<bool, String> {
    Ok(store.setting(KEEP_TERMS_SETTING).map_err(|e| e.to_string())?.as_deref() != Some("off"))
}

pub fn set_keep_terms(store: &Store, on: bool) -> Result<(), String> {
    store.set_setting(KEEP_TERMS_SETTING, (!on).then_some("off")).map_err(|e| e.to_string())
}

pub fn instructions(store: &Store) -> Result<String, String> {
    Ok(store.setting(INSTRUCTIONS_SETTING).map_err(|e| e.to_string())?.unwrap_or_default())
}

pub fn set_instructions(store: &Store, text: &str) -> Result<(), String> {
    let text = text.trim();
    if text.chars().count() > MAX_INSTRUCTION_CHARS {
        return Err(format!("追加の指示は {MAX_INSTRUCTION_CHARS} 文字までです"));
    }
    store.set_setting(INSTRUCTIONS_SETTING, (!text.is_empty()).then_some(text)).map_err(|e| e.to_string())
}

/// The current settings' target for non-Japanese sources (`Target::for_source` adapts it).
pub fn target(store: &Store) -> Result<Target, String> {
    Ok(Target { language: TARGET_LANGUAGE, keep_terms: keep_terms(store)?, instructions: instructions(store)? })
}

/// The current settings' target for one article: English if the article is Japanese.
pub fn article_target(store: &Store, article_id: i64) -> Result<Target, String> {
    Ok(target(store)?.for_source(store.article_is_japanese(article_id).map_err(|e| e.to_string())?))
}

/// The job keeps the target it was queued with, so changing settings meanwhile does not mix modes.
pub fn enqueue(store: &Store, article_id: i64, target: &Target) -> Result<(), String> {
    let key = target.key();
    let params = serde_json::json!({ "target_language": key, "instructions": target.instructions }).to_string();
    store.enqueue_job(JOB_TYPE, article_id, &params, &format!("{JOB_TYPE}:{article_id}:{key}")).map_err(|e| e.to_string())
}

fn batches(blocks: Vec<PendingBlock>) -> Vec<Vec<PendingBlock>> {
    let mut out: Vec<Vec<PendingBlock>> = Vec::new();
    let mut chars = 0;
    for b in blocks {
        let len = b.text.chars().count();
        match out.last_mut() {
            Some(batch) if batch.len() < BATCH_ITEMS && chars + len <= BATCH_CHARS => {
                chars += len;
                batch.push(b);
            }
            _ => {
                chars = len;
                out.push(vec![b]);
            }
        }
    }
    out
}

pub async fn run<P: LlmProvider>(
    store: &Store,
    provider: &P,
    article_id: i64,
    target: &Target,
    on_progress: &(dyn Fn() + Send + Sync),
) -> Result<(), String> {
    let key = target.key();
    let mut pending = store.untranslated_blocks(article_id, &key, PROSE_KINDS).map_err(|e| e.to_string())?;
    // Same paragraph twice translates once; a paragraph already in the target language needs none.
    let mut seen = std::collections::HashSet::new();
    pending.retain(|b| seen.insert(b.text_hash.clone()) && !target.is_written_in(&b.text));
    let mut missing = 0;
    for batch in batches(pending) {
        let snippets: Vec<String> = batch.iter().map(|b| snippet_from_inlines(&b.text, &b.inlines)).collect();
        let t = segments::translate_snippets(provider, &snippets, target).await;
        let rows: Vec<SegmentRow> = batch
            .iter()
            .zip(&t.results)
            .filter_map(|(b, r)| r.as_ref().map(|(units, o)| (b.text_hash.as_str(), &units[..], o.provider.as_str(), o.model.as_deref())))
            .collect();
        missing += batch.len() - rows.len();
        if rows.is_empty() {
            if let Some(e) = t.error {
                return Err(e.to_string()); // provider down or rate-limited: back off instead of hammering
            }
        }
        store
            .insert_segments(&key, PROMPT_VERSION, &rows)
            .map_err(|e| e.to_string())?;
        on_progress();
    }
    if missing > 0 {
        return Err(format!("{missing} blocks were not returned by the provider"));
    }
    Ok(())
}
