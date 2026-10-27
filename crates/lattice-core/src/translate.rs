//! Article translation job: translates an article's prose blocks with the reading-unit
//! algorithm (`segments.rs`), in batches sent a few at a time and persisted in order, so a usage limit
//! mid-article loses nothing and a retry only sends what is still missing.

use crate::ir::PROSE_KINDS;
use crate::llm::LlmProvider;
use crate::msg;
use crate::segments::{self, PROMPT_VERSION, Target, snippet_from_inlines};
use crate::store::{PendingBlock, SegmentRow, Store};
use futures::{StreamExt, stream};
use rusqlite::OptionalExtension;

pub const JOB_TYPE: &str = "translate";
pub const TARGET_LANGUAGE: &str = "ja";
/// "off" translates technical terms too; absent means keep them in English (§8).
pub const KEEP_TERMS_SETTING: &str = "translate_keep_terms";
/// The user's extra instructions for the translation prompt; absent means none.
pub const INSTRUCTIONS_SETTING: &str = "translate_instructions";
pub const MAX_INSTRUCTION_CHARS: usize = 2000;
/// "on" translates each saved article once it is extracted; absent means off, since it spends LLM usage.
pub const AUTO_SETTING: &str = "auto_translate";
const BATCH_CHARS: usize = 6000;
const BATCH_ITEMS: usize = 12;
/// Batches of one article in flight at once: a long article is ready several times sooner, and a
/// provider (one CLI process per call, or an API's rate limit) sees at most this many calls.
const PARALLEL_BATCHES: usize = 3;

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
        return Err(msg!("translate.instructionsTooLong", max = MAX_INSTRUCTION_CHARS));
    }
    store.set_setting(INSTRUCTIONS_SETTING, (!text.is_empty()).then_some(text)).map_err(|e| e.to_string())
}

pub fn auto_enabled(store: &Store) -> Result<bool, String> {
    Ok(store.setting(AUTO_SETTING).map_err(|e| e.to_string())?.as_deref() == Some("on"))
}

pub fn set_auto(store: &Store, on: bool) -> Result<(), String> {
    store.set_setting(AUTO_SETTING, on.then_some("on")).map_err(|e| e.to_string())
}

/// After ingest: queue an extracted article's translation if auto translation is on. Japanese
/// articles are left alone: the reader reads them as they are, and English output would only cost usage.
pub fn enqueue_if_auto(store: &Store, article_id: i64) -> Result<(), String> {
    if !auto_enabled(store)? {
        return Ok(());
    }
    let extracted: bool = store
        .conn()
        .query_row("SELECT extraction_status = 'ok' FROM articles WHERE id = ?1", [article_id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(false);
    if !extracted || store.article_is_japanese(article_id).map_err(|e| e.to_string())? {
        return Ok(());
    }
    enqueue(store, article_id, &target(store)?)
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

/// Translates the article anew: drops its cached translations for `target` (also those of
/// paragraphs other articles share, which then get the new translation) and queues the job,
/// which now finds every block untranslated. Returns how many translations were dropped.
pub fn retranslate(store: &Store, article_id: i64, target: &Target) -> Result<usize, String> {
    let dropped = store.drop_translations(article_id, &target.key(), PROSE_KINDS).map_err(|e| e.to_string())?;
    enqueue(store, article_id, target)?;
    Ok(dropped)
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

pub async fn run<P: LlmProvider>(store: &Store, provider: &P, article_id: i64, target: &Target, on_progress: &(dyn Fn() + Send + Sync)) -> Result<(), String> {
    let key = target.key();
    let mut pending = store.untranslated_blocks(article_id, &key, PROSE_KINDS).map_err(|e| e.to_string())?;
    // Same paragraph twice translates once; a paragraph already in the target language needs none.
    let mut seen = std::collections::HashSet::new();
    pending.retain(|b| seen.insert(b.text_hash.clone()) && !target.is_written_in(&b.text));
    let mut missing = 0;
    // `buffered` keeps the article's order: the top of the article is saved (and shown) first.
    let mut done = stream::iter(batches(pending))
        .map(|batch| async move {
            let snippets: Vec<String> = batch.iter().map(|b| snippet_from_inlines(&b.text, &b.inlines)).collect();
            let t = segments::translate_snippets(provider, &snippets, target).await;
            (batch, t)
        })
        .buffered(PARALLEL_BATCHES);
    while let Some((batch, t)) = done.next().await {
        let rows: Vec<SegmentRow> = batch
            .iter()
            .zip(&t.results)
            .filter_map(|(b, r)| r.as_ref().map(|(units, o)| (b.text_hash.as_str(), &units[..], o.provider.as_str(), o.model.as_deref())))
            .collect();
        missing += batch.len() - rows.len();
        if rows.is_empty()
            && let Some(e) = t.error
        {
            // Provider down or rate-limited: back off instead of hammering (batches in flight are dropped).
            return Err(e.to_string());
        }
        store.insert_segments(&key, PROMPT_VERSION, &rows).map_err(|e| e.to_string())?;
        on_progress();
    }
    if missing > 0 {
        return Err(format!("{missing} blocks were not returned by the provider"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fetch::Fetched;
    use crate::ingest::store_fetched;
    use crate::llm::{Completion, LlmError};
    use crate::segments::tests::Fake;
    use serde_json::Value;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// `Fake`, slow enough that calls overlap, counting how many are in flight at once.
    struct Slow {
        fake: Fake,
        now: AtomicUsize,
        most: AtomicUsize,
    }

    impl LlmProvider for Slow {
        fn name(&self) -> &str {
            "slow"
        }
        async fn complete_json(&self, system: &str, input: &str, schema: &Value) -> Result<Completion, LlmError> {
            let n = self.now.fetch_add(1, Ordering::SeqCst) + 1;
            self.most.fetch_max(n, Ordering::SeqCst);
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            self.now.fetch_sub(1, Ordering::SeqCst);
            self.fake.complete_json(system, input, schema).await
        }
    }

    #[tokio::test]
    async fn an_articles_batches_are_translated_a_few_at_a_time() {
        let s = Store::open_in_memory().unwrap();
        let (id, _) = s.upsert_pending("https://a.dev/long", "https://a.dev/long", "a.dev").unwrap();
        let paras: String = (0..60).map(|i| format!("<p>Paragraph {i} explains how snapshot isolation handles write skew in practice.</p>")).collect();
        let html = format!("<html><body><article>{paras}</article></body></html>");
        store_fetched(&s, id, &Fetched { final_url: "https://a.dev/long".into(), status: 200, content_type: None, html }).unwrap();
        let slow = Slow { fake: Fake::new(), now: AtomicUsize::new(0), most: AtomicUsize::new(0) };
        let saved = AtomicUsize::new(0);

        run(&s, &slow, id, &Target::default(), &|| {
            saved.fetch_add(1, Ordering::SeqCst);
        })
        .await
        .unwrap();
        assert_eq!(saved.load(Ordering::SeqCst), 5, "60 paragraphs in batches of 12");
        assert_eq!(slow.most.load(Ordering::SeqCst), PARALLEL_BATCHES);
        let v = s.get_article(id, "ja").unwrap().unwrap();
        assert!(v.blocks.iter().all(|b| b.translation.is_some()), "every batch saved");
    }
}
