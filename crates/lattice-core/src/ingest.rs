//! URL -> fetch -> extract -> store. Failures are recorded on the article, not raised:
//! a failed article stays visible and saving the same URL again retries it.

use crate::extract::extract;
use crate::fetch::{Fetched, fetch};
use crate::store::Store;
use crate::url_norm::normalize;

pub async fn save_url(store: &Store, client: &reqwest::Client, url: &str) -> Result<i64, String> {
    let norm = normalize(url)?;
    let domain = norm.host_str().unwrap_or_default().to_string();
    let (id, needs_work) = store.upsert_pending(url.trim(), norm.as_str(), &domain).map_err(|e| e.to_string())?;
    if !needs_work {
        return Ok(id);
    }
    match fetch(client, url.trim()).await {
        Ok(fetched) => store_fetched(store, id, &fetched),
        Err(e) => {
            store.record_fetch_failure(id, &e).map_err(|e| e.to_string())?;
            Ok(id)
        }
    }
}

/// Network-free half of the pipeline, also used by tests.
pub fn store_fetched(store: &Store, id: i64, fetched: &Fetched) -> Result<i64, String> {
    let extracted = extract(&fetched.html, &fetched.final_url).map_err(|e| e.to_string());
    let canonical = extracted
        .as_ref()
        .ok()
        .and_then(|ir| ir.meta.canonical_url.as_deref())
        .and_then(|c| normalize(c).ok())
        .map(String::from);
    store.save_fetched(id, fetched, extracted, canonical.as_deref()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(body: &str) -> Fetched {
        Fetched {
            final_url: "https://example.com/post".into(),
            status: 200,
            content_type: Some("text/html".into()),
            html: format!(r#"<html><head><title>T</title><link rel="canonical" href="https://example.com/post?utm_source=feed"></head><body><article>{body}</article></body></html>"#),
        }
    }

    const BODY: &str = "<h2>Section</h2><p>Snapshot isolation prevents dirty reads but still permits write skew, which is why SSI exists. This sentence pads the paragraph so readability keeps it.</p>";

    #[test]
    fn stores_blocks_and_dedups() {
        let s = Store::open_in_memory().unwrap();
        let (id, needs) = s.upsert_pending("https://example.com/post", "https://example.com/post", "example.com").unwrap();
        assert!(needs);
        assert_eq!(store_fetched(&s, id, &page(BODY)).unwrap(), id);

        let v = s.get_article(id).unwrap().unwrap();
        assert_eq!(v.article.extraction_status, "ok");
        assert_eq!(v.article.canonical_url.as_deref(), Some("https://example.com/post"));
        assert_eq!(v.blocks.len(), 2);
        assert_eq!(v.blocks[1].heading_id, Some(v.blocks[0].id));

        // Same URL again: already extracted, nothing to do.
        assert_eq!(s.upsert_pending("https://example.com/post#x", "https://example.com/post", "example.com").unwrap(), (id, false));

        // Different URL whose canonical points at the first article collapses into it.
        let (id2, _) = s.upsert_pending("https://example.com/p?id=1", "https://example.com/p?id=1", "example.com").unwrap();
        assert_eq!(store_fetched(&s, id2, &page(BODY)).unwrap(), id);
        assert_eq!(s.list_articles().unwrap().len(), 1);
    }

    #[test]
    fn extraction_failure_is_recorded_and_retryable() {
        let s = Store::open_in_memory().unwrap();
        let (id, _) = s.upsert_pending("https://example.com/post", "https://example.com/post", "example.com").unwrap();
        store_fetched(&s, id, &page("")).unwrap();
        let a = s.get_article(id).unwrap().unwrap().article;
        assert_eq!((a.fetch_status.as_str(), a.extraction_status.as_str()), ("ok", "failed"));
        assert!(s.upsert_pending("https://example.com/post", "https://example.com/post", "example.com").unwrap().1);
    }
}
