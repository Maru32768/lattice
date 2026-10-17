//! Article translation job: translates an article's prose blocks with the reading-unit
//! algorithm (`segments.rs`), in batches persisted as they return, so a usage limit
//! mid-article loses nothing and a retry only sends what is still missing.

use crate::ir::PROSE_KINDS;
use crate::llm::LlmProvider;
use crate::segments::{self, PROMPT_VERSION, is_cjk_dominant, snippet_from_inlines};
use crate::store::{PendingBlock, SegmentRow, Store};

pub const JOB_TYPE: &str = "translate";
pub const TARGET_LANGUAGE: &str = "ja";
pub const SOURCE_LANGUAGE: &str = "en";
/// "off" translates technical terms too; absent means keep them in English (§8).
pub const KEEP_TERMS_SETTING: &str = "translate_keep_terms";
const BATCH_CHARS: usize = 6000;
const BATCH_ITEMS: usize = 12;

pub fn keep_terms(store: &Store) -> Result<bool, String> {
    Ok(store.setting(KEEP_TERMS_SETTING).map_err(|e| e.to_string())?.as_deref() != Some("off"))
}

pub fn set_keep_terms(store: &Store, on: bool) -> Result<(), String> {
    store.set_setting(KEEP_TERMS_SETTING, (!on).then_some("off")).map_err(|e| e.to_string())
}

/// `TARGET_LANGUAGE` in the current term mode: the key for jobs, the cache and display.
pub fn target(store: &Store) -> Result<String, String> {
    Ok(segments::target_key(TARGET_LANGUAGE, keep_terms(store)?))
}

pub fn enqueue(store: &Store, article_id: i64, target_language: &str) -> Result<(), String> {
    let params = serde_json::json!({ "target_language": target_language }).to_string();
    let key = format!("{JOB_TYPE}:{article_id}:{target_language}");
    store.enqueue_job(JOB_TYPE, article_id, &params, &key).map_err(|e| e.to_string())
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
    target_language: &str,
    on_progress: &(dyn Fn() + Send + Sync),
) -> Result<(), String> {
    let mut pending = store.untranslated_blocks(article_id, target_language, PROSE_KINDS).map_err(|e| e.to_string())?;
    // Same paragraph twice translates once; Japanese paragraphs need no Japanese translation.
    let mut seen = std::collections::HashSet::new();
    pending.retain(|b| seen.insert(b.text_hash.clone()) && !is_cjk_dominant(&b.text));
    let mut missing = 0;
    for batch in batches(pending) {
        let snippets: Vec<String> = batch.iter().map(|b| snippet_from_inlines(&b.text, &b.inlines)).collect();
        let t = segments::translate_snippets(provider, &snippets, SOURCE_LANGUAGE, target_language).await;
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
            .insert_segments(target_language, PROMPT_VERSION, &rows)
            .map_err(|e| e.to_string())?;
        on_progress();
    }
    if missing > 0 {
        return Err(format!("{missing} blocks were not returned by the provider"));
    }
    Ok(())
}
