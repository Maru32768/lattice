//! Embeddings: provider boundary, the local multilingual-e5 adapter, and the embed job.
//! Runs fully offline once the model is cached, so semantic search needs no LLM or network.

use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use fastembed::{EmbeddingModel, TextEmbedding, TextInitOptions};

use crate::ir::PROSE_KINDS;
use crate::store::Store;

pub const JOB_TYPE: &str = "embed";
const BATCH: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Purpose {
    Query,
    Passage,
}

pub trait EmbeddingProvider: Send + Sync + 'static {
    /// Stored with every vector; vectors from different models are never compared.
    fn model_id(&self) -> &str;
    /// Returns one L2-normalized vector per text.
    fn embed(&self, texts: Vec<String>, purpose: Purpose) -> impl Future<Output = Result<Vec<Vec<f32>>, String>> + Send;
}

/// intfloat/multilingual-e5-small via ONNX Runtime: 384 dims, cross-lingual (ja query ↔ en text).
/// The model (~470MB) is downloaded into `cache_dir` on first use and loaded lazily.
pub struct LocalE5 {
    cache_dir: PathBuf,
    model: Arc<Mutex<Option<TextEmbedding>>>,
}

impl LocalE5 {
    pub fn new(cache_dir: PathBuf) -> Self {
        Self { cache_dir, model: Arc::new(Mutex::new(None)) }
    }
}

impl EmbeddingProvider for LocalE5 {
    fn model_id(&self) -> &str {
        "multilingual-e5-small"
    }

    async fn embed(&self, texts: Vec<String>, purpose: Purpose) -> Result<Vec<Vec<f32>>, String> {
        // e5 is trained with these prefixes; omitting them noticeably hurts retrieval.
        let prefix = match purpose {
            Purpose::Query => "query: ",
            Purpose::Passage => "passage: ",
        };
        let texts: Vec<String> = texts.into_iter().map(|t| format!("{prefix}{t}")).collect();
        let (model, cache_dir) = (self.model.clone(), self.cache_dir.clone());
        // CPU-bound (and the first call downloads): keep it off the async runtime threads.
        tokio::task::spawn_blocking(move || {
            let mut guard = model.lock().unwrap_or_else(|e| e.into_inner());
            if guard.is_none() {
                let opts = TextInitOptions::new(EmbeddingModel::MultilingualE5Small).with_cache_dir(cache_dir).with_show_download_progress(false);
                *guard = Some(TextEmbedding::try_new(opts).map_err(|e| format!("loading embedding model: {e}"))?);
            }
            let vecs = guard.as_mut().expect("initialized above").embed(&texts, Some(BATCH)).map_err(|e| e.to_string())?;
            Ok(vecs.into_iter().map(normalize).collect())
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

pub fn normalize(mut v: Vec<f32>) -> Vec<f32> {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > 0.0 {
        v.iter_mut().for_each(|x| *x /= n);
    }
    v
}

pub fn enqueue(store: &Store, article_id: i64, model: &str) -> Result<(), String> {
    let params = serde_json::json!({ "model": model }).to_string();
    let key = format!("{JOB_TYPE}:{article_id}:{model}");
    store.enqueue_job(JOB_TYPE, article_id, &params, &key).map_err(|e| e.to_string())
}

/// The section heading gives short blocks (list items, one-liners) the context they lack.
fn passage(heading: Option<&str>, text: &str) -> String {
    match heading {
        Some(h) if h != text => format!("{h}\n{text}"),
        _ => text.to_string(),
    }
}

pub async fn run<E: EmbeddingProvider>(store: &Store, embedder: &E, article_id: i64) -> Result<(), String> {
    let model = embedder.model_id();
    let pending = store.unembedded_blocks(article_id, model, PROSE_KINDS).map_err(|e| e.to_string())?;
    for chunk in pending.chunks(BATCH) {
        let texts = chunk.iter().map(|b| passage(b.heading.as_deref(), &b.text)).collect();
        let vecs = embedder.embed(texts, Purpose::Passage).await?;
        if vecs.len() != chunk.len() {
            return Err(format!("embedder returned {} vectors for {} texts", vecs.len(), chunk.len()));
        }
        let items: Vec<_> = chunk.iter().zip(vecs.iter().map(Vec::as_slice)).collect();
        store.upsert_embeddings(model, &items).map_err(|e| e.to_string())?;
    }
    Ok(())
}
