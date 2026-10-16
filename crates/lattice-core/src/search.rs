//! Hybrid search over blocks: FTS (exact terms like `EPOLLET`) + vectors (meaning),
//! merged with Reciprocal Rank Fusion. RRF needs no score calibration between the two,
//! which raw bm25 and cosine values would.

use std::collections::{BinaryHeap, HashMap};
use std::cmp::Reverse;

use serde::Serialize;

use crate::embed::{EmbeddingProvider, Purpose};
use crate::store::{HitDetail, Store};

const CANDIDATES: usize = 50;
const RRF_K: f64 = 60.0;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchSource {
    Lexical,
    Semantic,
    Both,
}

#[derive(Debug, Serialize)]
pub struct SearchHit {
    #[serde(flatten)]
    pub detail: HitDetail,
    pub source: MatchSource,
    pub score: f64,
}

#[derive(Debug, Serialize)]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    /// Set when semantic search could not run (model not downloaded yet, ...): results are lexical only.
    pub semantic_error: Option<String>,
}

pub async fn search<E: EmbeddingProvider>(
    store: &Store,
    embedder: &E,
    query: &str,
    target_language: &str,
    limit: usize,
) -> Result<SearchResult, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(SearchResult { hits: Vec::new(), semantic_error: None });
    }
    let lexical = store.lexical_search(query, CANDIDATES).map_err(|e| e.to_string())?;
    let (semantic, semantic_error) = match semantic_search(store, embedder, query).await {
        Ok(ids) => (ids, None),
        Err(e) => (Vec::new(), Some(e)),
    };
    let fused = fuse(&lexical, &semantic, limit);
    let ids: Vec<i64> = fused.iter().map(|f| f.0).collect();
    let details = store.hit_details(&ids, target_language).map_err(|e| e.to_string())?;
    let by_id: HashMap<i64, (MatchSource, f64)> = fused.into_iter().map(|(id, s, sc)| (id, (s, sc))).collect();
    let hits = details
        .into_iter()
        .map(|d| {
            let (source, score) = by_id[&d.block_id];
            SearchHit { detail: d, source, score }
        })
        .collect();
    Ok(SearchResult { hits, semantic_error })
}

async fn semantic_search<E: EmbeddingProvider>(store: &Store, embedder: &E, query: &str) -> Result<Vec<i64>, String> {
    let q = embedder.embed(vec![query.to_string()], Purpose::Query).await?.pop().ok_or("no query vector")?;
    // Min-heap of the best CANDIDATES by dot product (vectors are normalized, so = cosine).
    let mut top: BinaryHeap<Reverse<(Ordered, i64)>> = BinaryHeap::new();
    store
        .scan_embeddings(embedder.model_id(), |id, v| {
            if v.len() != q.len() {
                return;
            }
            let s = Ordered(v.iter().zip(&q).map(|(a, b)| a * b).sum());
            if top.len() < CANDIDATES {
                top.push(Reverse((s, id)));
            } else if top.peek().is_some_and(|Reverse((min, _))| s > *min) {
                top.pop();
                top.push(Reverse((s, id)));
            }
        })
        .map_err(|e| e.to_string())?;
    let mut ranked: Vec<_> = top.into_iter().map(|Reverse(x)| x).collect();
    ranked.sort_by(|a, b| b.cmp(a));
    Ok(ranked.into_iter().map(|(_, id)| id).collect())
}

#[derive(Debug, Clone, Copy, PartialEq, PartialOrd)]
struct Ordered(f32);
impl Eq for Ordered {}
impl Ord for Ordered {
    fn cmp(&self, o: &Self) -> std::cmp::Ordering {
        self.0.total_cmp(&o.0)
    }
}

/// Reciprocal Rank Fusion over two best-first id lists.
fn fuse(lexical: &[i64], semantic: &[i64], limit: usize) -> Vec<(i64, MatchSource, f64)> {
    let mut acc: HashMap<i64, (MatchSource, f64)> = HashMap::new();
    for (list, src) in [(lexical, MatchSource::Lexical), (semantic, MatchSource::Semantic)] {
        for (rank, &id) in list.iter().enumerate() {
            let e = acc.entry(id).or_insert((src, 0.0));
            if e.0 != src {
                e.0 = MatchSource::Both;
            }
            e.1 += 1.0 / (RRF_K + rank as f64 + 1.0);
        }
    }
    let mut out: Vec<_> = acc.into_iter().map(|(id, (s, sc))| (id, s, sc)).collect();
    out.sort_by(|a, b| b.2.total_cmp(&a.2).then(a.0.cmp(&b.0)));
    out.truncate(limit);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fetch::Fetched;
    use crate::ingest::store_fetched;
    use crate::segments::Unit;

    #[test]
    fn rrf_prefers_agreement() {
        let f = fuse(&[1, 2, 3], &[3, 4], 10);
        assert_eq!(f[0], (3, MatchSource::Both, 1.0 / 63.0 + 1.0 / 61.0));
        assert_eq!(f.iter().find(|x| x.0 == 4).unwrap().1, MatchSource::Semantic);
        assert_eq!(fuse(&[1, 2, 3], &[], 2).len(), 2);
    }

    /// Bag-of-letters vectors: texts sharing letters are "semantically" close.
    struct Letters;
    impl EmbeddingProvider for Letters {
        fn model_id(&self) -> &str {
            "letters"
        }
        async fn embed(&self, texts: Vec<String>, _: Purpose) -> Result<Vec<Vec<f32>>, String> {
            Ok(texts
                .iter()
                .map(|t| {
                    let mut v = vec![0.0; 26];
                    t.to_ascii_lowercase().bytes().filter(u8::is_ascii_lowercase).for_each(|b| v[(b - b'a') as usize] += 1.0);
                    crate::embed::normalize(v)
                })
                .collect())
        }
    }

    struct Offline;
    impl EmbeddingProvider for Offline {
        fn model_id(&self) -> &str {
            "letters"
        }
        async fn embed(&self, _: Vec<String>, _: Purpose) -> Result<Vec<Vec<f32>>, String> {
            Err("model not downloaded".into())
        }
    }

    fn store_with(body: &str) -> (Store, i64) {
        let s = Store::open_in_memory().unwrap();
        let (id, _) = s.upsert_pending("https://example.com/a", "https://example.com/a", "example.com").unwrap();
        let html = format!("<html><head><title>MVCC notes</title></head><body><article>{body}</article></body></html>");
        store_fetched(&s, id, &Fetched { final_url: "https://example.com/a".into(), status: 200, content_type: None, html }).unwrap();
        (s, id)
    }

    const BODY: &str = "<h2>Visibility</h2>\
        <p>PostgreSQL keeps tuple visibility in the heap, so pg_visibility inspects the visibility map rather than the index entries.</p>\
        <p>Edge-triggered polling with EPOLLET requires draining the socket until EAGAIN is returned by the kernel.</p>\
        <pre><code>SELECT * FROM pg_visibility_map('t');</code></pre>";

    #[tokio::test]
    async fn lexical_semantic_and_fallbacks() {
        let (s, id) = store_with(BODY);
        crate::embed::run(&s, &Letters, id).await.unwrap();

        // Exact identifier, case-insensitive, also inside code blocks.
        let r = search(&s, &Letters, "epollet", "ja", 10).await.unwrap();
        assert!(r.hits[0].detail.text.contains("EPOLLET"));
        assert_eq!(r.hits[0].detail.heading.as_deref(), Some("Visibility"));
        assert_eq!(r.hits[0].detail.article_title, "MVCC notes");
        let r = search(&s, &Letters, "pg_visibility_map", "ja", 10).await.unwrap();
        assert!(r.hits.iter().any(|h| h.detail.text.starts_with("SELECT") && h.source != MatchSource::Semantic));

        // A Japanese query matches the stored translation lexically, including a 2-char term via LIKE.
        let b = &s.get_article(id, "ja").unwrap().unwrap().blocks[1];
        let p = (b.id, crate::store::sha256_hex(&b.block.text));
        let units = [Unit { source: "x".into(), translation: "可視性情報は<b>ヒープ</b>に保持される".into() }];
        s.insert_segments("ja", "fake", None, "v", &[(p.1.as_str(), &units[..])]).unwrap();
        for q in ["可視性情報", "ヒープ", "可視性 保持"] {
            let r = search(&s, &Offline, q, "ja", 10).await.unwrap();
            assert_eq!(r.hits.first().map(|h| h.detail.block_id), Some(p.0), "query {q}");
            assert_eq!(r.hits[0].detail.translation.as_deref(), Some("可視性情報はヒープに保持される"));
        }

        // Semantic-only match, and graceful degradation when the embedder is unavailable.
        let r = search(&s, &Letters, "tuple heap visibility", "ja", 10).await.unwrap();
        assert!(r.hits.iter().any(|h| h.source != MatchSource::Lexical));
        let r = search(&s, &Offline, "EPOLLET", "ja", 10).await.unwrap();
        assert_eq!(r.semantic_error.as_deref(), Some("model not downloaded"));
        assert_eq!(r.hits.len(), 1);

        // FTS syntax in user input is literal, not an error.
        assert!(search(&s, &Offline, "\"unbalanced OR (", "ja", 10).await.is_ok());

        // Deleting an article removes its blocks and translations from the index.
        s.exec_for_test(&format!("DELETE FROM articles WHERE id = {id}"));
        assert!(search(&s, &Offline, "EPOLLET", "ja", 10).await.unwrap().hits.is_empty());
        assert!(search(&s, &Offline, "可視性情報", "ja", 10).await.unwrap().hits.is_empty());
    }
}
