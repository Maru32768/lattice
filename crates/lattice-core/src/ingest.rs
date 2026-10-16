//! URL -> fetch -> extract -> store. Failures are recorded on the article, not raised:
//! a failed article stays visible and saving the same URL again retries it.

use crate::extract::extract;
use crate::fetch::{Fetched, fetch};
use crate::store::Store;
use crate::url_norm::normalize;

pub const JOB_TYPE: &str = "ingest";

pub async fn save_url(store: &Store, client: &reqwest::Client, url: &str) -> Result<i64, String> {
    let norm = normalize(url)?;
    let domain = norm.host_str().unwrap_or_default().to_string();
    let (id, needs_work) = store.upsert_pending(url.trim(), norm.as_str(), &domain).map_err(|e| e.to_string())?;
    if !needs_work {
        return Ok(id);
    }
    fetch_into(store, client, id, url.trim()).await
}

/// Background half of bulk import: fetches an article registered by `enqueue_urls`.
pub async fn process(store: &Store, client: &reqwest::Client, article_id: i64) -> Result<i64, String> {
    let url = store.article_url(article_id).map_err(|e| e.to_string())?.ok_or("article no longer exists")?;
    fetch_into(store, client, article_id, &url).await
}

async fn fetch_into(store: &Store, client: &reqwest::Client, id: i64, url: &str) -> Result<i64, String> {
    match fetch(client, url).await {
        Ok(fetched) => store_fetched(store, id, &fetched),
        Err(e) => {
            store.record_fetch_failure(id, &e).map_err(|e| e.to_string())?;
            Ok(id)
        }
    }
}

#[derive(Debug, Default, PartialEq, serde::Serialize)]
pub struct ImportSummary {
    pub found: usize,
    pub queued: usize,
    pub existing: usize,
    pub invalid: usize,
}

/// Registers every URL as a pending article and queues a fetch job for those not yet saved.
/// Invalid URLs are counted, not fatal.
pub fn enqueue_urls(store: &Store, urls: &[String]) -> Result<ImportSummary, String> {
    let mut s = ImportSummary { found: urls.len(), ..Default::default() };
    for url in urls {
        let Ok(norm) = normalize(url) else {
            s.invalid += 1;
            continue;
        };
        let domain = norm.host_str().unwrap_or_default();
        let (id, needs_work) = store.upsert_pending(url, norm.as_str(), domain).map_err(|e| e.to_string())?;
        if needs_work {
            store.enqueue_job(JOB_TYPE, id, "{}", &format!("{JOB_TYPE}:{id}")).map_err(|e| e.to_string())?;
            s.queued += 1;
        } else {
            s.existing += 1;
        }
    }
    Ok(s)
}

/// Pulls http(s) URLs out of any text: URL lists, bookmarks HTML, CSV, JSON, Markdown.
/// Order is kept and duplicates (by normalized URL) dropped.
pub fn extract_urls(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut rest = text;
    while let Some(start) = ["https://", "http://"].iter().filter_map(|p| rest.find(p)).min() {
        let tail = &rest[start..];
        let end = tail
            .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | '`' | ',' | '|' | '{' | '}'))
            .unwrap_or(tail.len());
        let mut url = tail[..end].replace("&amp;", "&");
        // Trailing punctuation belongs to the surrounding prose; a ')' only if unbalanced (Markdown links).
        loop {
            let unbalanced = url.ends_with(')') && url.matches('(').count() < url.matches(')').count();
            if url.ends_with(['.', ';', ':', '!', '?', ']']) || unbalanced {
                url.pop();
            } else {
                break;
            }
        }
        if let Ok(norm) = normalize(&url) {
            if seen.insert(norm.to_string()) {
                out.push(url);
            }
        }
        rest = &tail[end.max(1)..];
    }
    out
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

    #[test]
    fn extracts_urls_from_any_format() {
        let text = r#"https://a.dev/x?utm_source=feed
            <DT><A HREF="https://b.dev/post?id=1&amp;p=2" ADD_DATE="1">B</A>
            "c",https://c.dev/y,2024-01-01
            {"url": "https://d.dev/z"} see [docs](https://e.dev/wiki/Rust_(lang)) and https://f.dev/end.
            dup https://a.dev/x#frag ftp://nope.dev"#;
        assert_eq!(
            extract_urls(text),
            [
                "https://a.dev/x?utm_source=feed",
                "https://b.dev/post?id=1&p=2",
                "https://c.dev/y",
                "https://d.dev/z",
                "https://e.dev/wiki/Rust_(lang)",
                "https://f.dev/end",
            ]
        );
    }

    #[test]
    fn enqueue_counts_and_is_idempotent() {
        let s = Store::open_in_memory().unwrap();
        let urls: Vec<String> = ["https://a.dev/1", "https://a.dev/2", "notaurl"].map(String::from).to_vec();
        assert_eq!(enqueue_urls(&s, &urls).unwrap(), ImportSummary { found: 3, queued: 2, existing: 0, invalid: 1 });
        // Not yet fetched: queued again, but dedup_key keeps one job per article.
        assert_eq!(enqueue_urls(&s, &urls[..1]).unwrap().queued, 1);
        assert_eq!(s.claim_next_job(&[JOB_TYPE]).unwrap().unwrap().article_id, Some(1));
        assert_eq!(s.claim_next_job(&[JOB_TYPE]).unwrap().unwrap().article_id, Some(2));
        assert!(s.claim_next_job(&[JOB_TYPE]).unwrap().is_none());
    }

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

        let v = s.get_article(id, "ja").unwrap().unwrap();
        assert_eq!(v.article.extraction_status, "ok");
        assert_eq!(v.article.canonical_url.as_deref(), Some("https://example.com/post"));
        assert_eq!(v.blocks.len(), 2);
        assert_eq!(v.blocks[1].heading_id, Some(v.blocks[0].id));
        assert_eq!(s.latest_snapshot(id).unwrap().unwrap().html, page(BODY).html, "snapshot round-trips through deflate");

        // Same URL again: already extracted, nothing to do.
        assert_eq!(s.upsert_pending("https://example.com/post#x", "https://example.com/post", "example.com").unwrap(), (id, false));

        // Different URL whose canonical points at the first article collapses into it.
        let (id2, _) = s.upsert_pending("https://example.com/p?id=1", "https://example.com/p?id=1", "example.com").unwrap();
        assert_eq!(store_fetched(&s, id2, &page(BODY)).unwrap(), id);
        assert_eq!(s.list_articles(&crate::store::ArticleFilter::All).unwrap().len(), 1);
    }

    #[test]
    fn extraction_failure_is_recorded_and_retryable() {
        let s = Store::open_in_memory().unwrap();
        let (id, _) = s.upsert_pending("https://example.com/post", "https://example.com/post", "example.com").unwrap();
        store_fetched(&s, id, &page("")).unwrap();
        let a = s.get_article(id, "ja").unwrap().unwrap().article;
        assert_eq!((a.fetch_status.as_str(), a.extraction_status.as_str()), ("ok", "failed"));
        assert!(s.upsert_pending("https://example.com/post", "https://example.com/post", "example.com").unwrap().1);
    }
}
