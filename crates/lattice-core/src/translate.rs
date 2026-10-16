//! Block-level translation job. One job per article; blocks are sent in batches and each
//! batch is persisted as soon as it returns, so a usage limit mid-article loses nothing and
//! the retry only sends what is still missing.

use std::collections::HashMap;

use crate::ir::Inline;
use crate::llm::{Item, LlmProvider};
use crate::store::{NewTranslation, PendingBlock, Store};

pub const JOB_TYPE: &str = "translate";
pub const TARGET_LANGUAGE: &str = "ja";
pub const PROMPT_VERSION: &str = "translate-v1";
/// Code, tables and images stay in the original language.
const KINDS: &[&str] = &["heading", "paragraph", "list_item", "blockquote", "caption"];
const BATCH_CHARS: usize = 6000;
const BATCH_ITEMS: usize = 40;

pub fn enqueue(store: &Store, article_id: i64, target_language: &str) -> Result<(), String> {
    let params = serde_json::json!({ "target_language": target_language }).to_string();
    let key = format!("{JOB_TYPE}:{article_id}:{target_language}");
    store.enqueue_job(JOB_TYPE, article_id, &params, &key).map_err(|e| e.to_string())
}

/// Inline code is wrapped in backticks so the model leaves it alone and the reader can restyle it.
fn source_text(b: &PendingBlock) -> String {
    if b.inlines.is_empty() {
        return b.text.clone();
    }
    b.inlines
        .iter()
        .map(|i| match i {
            Inline::Code { v } => format!("`{v}`"),
            Inline::Text { v } | Inline::Link { v, .. } => v.clone(),
        })
        .collect()
}

fn batches(items: Vec<Item>) -> Vec<Vec<Item>> {
    let mut out: Vec<Vec<Item>> = Vec::new();
    let mut chars = 0;
    for item in items {
        let len = item.text.chars().count();
        match out.last_mut() {
            Some(b) if b.len() < BATCH_ITEMS && chars + len <= BATCH_CHARS => {
                chars += len;
                b.push(item);
            }
            _ => {
                chars = len;
                out.push(vec![item]);
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
    let pending = store.untranslated_blocks(article_id, target_language, KINDS).map_err(|e| e.to_string())?;
    let by_id: HashMap<i64, &PendingBlock> = pending.iter().map(|b| (b.id, b)).collect();
    let items = pending.iter().map(|b| Item { id: b.id, text: source_text(b) }).collect();
    let mut missing = 0;
    for batch in batches(items) {
        let out = provider.translate(&batch, target_language).await.map_err(|e| e.to_string())?;
        // Ignore ids we didn't ask for: the model must not write to other blocks.
        let rows: Vec<NewTranslation> = out
            .items
            .iter()
            .filter(|i| batch.iter().any(|b| b.id == i.id) && !i.text.trim().is_empty())
            .map(|i| NewTranslation { block_id: i.id, source_hash: &by_id[&i.id].text_hash, text: i.text.trim() })
            .collect();
        missing += batch.len().saturating_sub(rows.len());
        store
            .insert_translations(target_language, provider.name(), out.model.as_deref(), PROMPT_VERSION, &rows)
            .map_err(|e| e.to_string())?;
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

    #[test]
    fn batches_respect_limits() {
        let item = |n: usize| Item { id: 0, text: "x".repeat(n) };
        let sizes = |v: Vec<Vec<Item>>| v.iter().map(Vec::len).collect::<Vec<_>>();
        assert_eq!(sizes(batches(vec![item(4000), item(2000), item(1)])), [2, 1]);
        assert_eq!(sizes(batches((0..41).map(|_| item(1)).collect())), [40, 1]);
        assert_eq!(sizes(batches(vec![item(9000), item(1)])), [1, 1]); // oversized item goes alone
    }
}
