//! URL -> fetch -> extract -> store. Failures are recorded on the article, not raised:
//! a failed article stays visible and saving the same URL again retries it.

use crate::extract::extract;
use crate::fetch::{Fetched, Resource, fetch_resource};
use crate::store::{Store, THIN_TEXT_CHARS};
use crate::url_norm::normalize;
use quick_xml::escape::escape;
use rusqlite::OptionalExtension;

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

/// A page that is refused (bot protection answers 403 to anything but a browser) or has no
/// text falls back to the feed entry's copy, when its feed carries one.
async fn fetch_into(store: &Store, client: &reqwest::Client, id: i64, url: &str) -> Result<i64, String> {
    store_fetch_result(store, id, fetch_resource(client, url).await)
}

/// Network-free half of `fetch_into`, also used by tests.
pub(crate) fn store_fetch_result(store: &Store, id: i64, fetched: Result<Resource, String>) -> Result<i64, String> {
    match fetched {
        Ok(fetched) => {
            let id = match fetched {
                Resource::Page(page) => store_fetched(store, id, &page)?,
                Resource::Pdf { final_url, bytes } => crate::pdf::store_fetched(store, id, &final_url, &bytes)?,
            };
            from_feed(store, id, None)?;
            Ok(id)
        }
        Err(e) => {
            store.record_fetch_failure(id, &e).map_err(|e| e.to_string())?;
            from_feed(store, id, Some(&e))?;
            Ok(id)
        }
    }
}

/// Marks snapshots holding a feed entry's own HTML (`feed_items.content`), not the page.
pub const FEED_CONTENT_TYPE: &str = "text/html; source=feed";

/// Stores the article's feed entry content through the normal pipeline (it is as untrusted as
/// any page) when the article has nothing better: no text, a thin one, or an earlier feed copy.
/// `page_error` stays as `last_error` to say why. Returns whether it stored anything.
fn from_feed(store: &Store, id: i64, page_error: Option<&str>) -> Result<bool, String> {
    let row: Option<(String, Option<String>, Vec<u8>, i64)> = store
        .conn()
        .query_row(
            "SELECT a.original_url, i.title, i.content,
                    CASE WHEN a.extraction_status = 'ok' AND (SELECT content_type FROM snapshots
                              WHERE article_id = a.id ORDER BY id DESC LIMIT 1) IS NOT ?2
                         THEN coalesce(a.text_length, 0) ELSE -1 END
             FROM articles a JOIN feed_items i ON i.feed_id = a.feed_id AND i.normalized_url = a.normalized_url
             WHERE a.id = ?1 AND i.content IS NOT NULL",
            rusqlite::params![id, FEED_CONTENT_TYPE],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((url, title, content, current)) = row.filter(|r| r.3 < THIN_TEXT_CHARS) else {
        return Ok(false);
    };
    let content = crate::store::inflate("deflate", &content).map_err(|e| e.to_string())?;
    let html = format!("<html><head><title>{}</title></head><body><article>{content}</article></body></html>", escape(title.as_deref().unwrap_or("")));
    let Ok(ir) = extract(&html, &url) else {
        return Ok(false);
    };
    if ir.blocks.iter().map(|b| b.text.chars().count() as i64).sum::<i64>() <= current {
        return Ok(false);
    }
    let id = store_fetched(store, id, &Fetched { final_url: url, status: 200, content_type: Some(FEED_CONTENT_TYPE.into()), html })?;
    // The entry's title is exact; Readability would cut "Title — Part II" at the dash as a site name.
    store
        .conn()
        .execute(
            "UPDATE articles SET title = coalesce(?2, title), last_error = coalesce(?3, last_error) WHERE id = ?1",
            rusqlite::params![id, title, page_error],
        )
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[derive(Debug, Default, PartialEq, serde::Serialize)]
pub struct ImportSummary {
    pub found: usize,
    pub queued: usize,
    pub existing: usize,
    pub invalid: usize,
    /// The articles the valid URLs are (new and already saved), in order.
    pub ids: Vec<i64>,
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
        s.ids.push(id);
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
        let end = tail.find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | '`' | ',' | '|' | '{' | '}')).unwrap_or(tail.len());
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
        if let Ok(norm) = normalize(&url)
            && seen.insert(norm.to_string())
        {
            out.push(url);
        }
        rest = &tail[end.max(1)..];
    }
    out
}

/// Network-free half of the pipeline, also used by tests.
pub fn store_fetched(store: &Store, id: i64, fetched: &Fetched) -> Result<i64, String> {
    extract_into(store, id, &fetched.html, &fetched.final_url, Some(fetched))
}

/// Saves the DOM of a page as rendered in the in-app browser: JS-built pages have little or
/// no content in their server HTML. Always re-extracts, since the user asked for this rendering.
pub fn save_rendered(store: &Store, url: &str, html: String) -> Result<i64, String> {
    let norm = normalize(url)?;
    let domain = norm.host_str().unwrap_or_default().to_string();
    let (id, _) = store.upsert_pending(url, norm.as_str(), &domain).map_err(|e| e.to_string())?;
    let fetched = Fetched { final_url: url.to_string(), status: 200, content_type: Some(RENDERED_CONTENT_TYPE.into()), html };
    store_fetched(store, id, &fetched)
}

/// Marks snapshots taken from the browser's DOM rather than fetched from the server.
pub const RENDERED_CONTENT_TYPE: &str = "text/html; source=webview";

/// Re-runs extraction on the newest stored snapshot: no network, and blocks whose text is
/// unchanged keep their ids (and with them embeddings and search hits).
pub fn reextract(store: &Store, id: i64) -> Result<i64, String> {
    let snap = store.latest_snapshot(id).map_err(|e| e.to_string())?.ok_or("no stored snapshot to re-extract")?;
    if snap.content_type.as_deref() == Some(crate::pdf::CONTENT_TYPE) {
        return crate::pdf::reextract(store, id, &snap.body);
    }
    if crate::markdown::is_local(&snap.final_url) {
        return crate::markdown::reextract(store, id, &snap.html());
    }
    extract_into(store, id, &snap.html(), &snap.final_url, None)
}

fn extract_into(store: &Store, id: i64, html: &str, url: &str, snapshot: Option<&Fetched>) -> Result<i64, String> {
    let extracted = extract(html, url).map_err(|e| e.to_string());
    let canonical = extracted.as_ref().ok().and_then(|ir| ir.meta.canonical_url.as_deref()).and_then(|c| normalize(c).ok()).map(String::from);
    let id = store.save_fetched(id, snapshot, extracted, canonical.as_deref()).map_err(|e| e.to_string())?;
    crate::images::enqueue(store, id)?;
    Ok(id)
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
        assert_eq!(enqueue_urls(&s, &urls).unwrap(), ImportSummary { found: 3, queued: 2, existing: 0, invalid: 1, ids: vec![1, 2] });
        // Not yet fetched: queued again, but dedup_key keeps one job per article.
        assert_eq!(enqueue_urls(&s, &urls[..1]).unwrap().queued, 1);
        let first = s.claim_next_job(&[JOB_TYPE]).unwrap().unwrap();
        assert_eq!(first.article_id, Some(1));
        s.finish_job(first.id, None).unwrap();
        assert_eq!(s.claim_next_job(&[JOB_TYPE]).unwrap().unwrap().article_id, Some(2));
        assert!(s.claim_next_job(&[JOB_TYPE]).unwrap().is_none());
    }

    fn page(body: &str) -> Fetched {
        Fetched {
            final_url: "https://example.com/post".into(),
            status: 200,
            content_type: Some("text/html".into()),
            html: format!(
                r#"<html><head><title>T</title><link rel="canonical" href="https://example.com/post?utm_source=feed"></head><body><article>{body}</article></body></html>"#
            ),
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
        assert_eq!(s.latest_snapshot(id).unwrap().unwrap().html(), page(BODY).html, "snapshot round-trips through deflate");

        // Same URL again: already extracted, nothing to do.
        assert_eq!(s.upsert_pending("https://example.com/post#x", "https://example.com/post", "example.com").unwrap(), (id, false));

        // Different URL whose canonical points at the first article collapses into it.
        let (id2, _) = s.upsert_pending("https://example.com/p?id=1", "https://example.com/p?id=1", "example.com").unwrap();
        assert_eq!(store_fetched(&s, id2, &page(BODY)).unwrap(), id);
        assert_eq!(s.list_articles(&crate::store::ArticleFilter::All).unwrap().len(), 1);
    }

    #[test]
    fn one_fetch_per_host_at_a_time() {
        let s = Store::open_in_memory().unwrap();
        let urls: Vec<String> = ["https://a.dev/1", "https://a.dev/2", "https://b.dev/1"].map(String::from).to_vec();
        enqueue_urls(&s, &urls).unwrap();
        let claim = || s.claim_next_job(&[JOB_TYPE]).unwrap().map(|j| (j.id, j.article_id.unwrap()));
        let (first, a1) = claim().unwrap();
        assert_eq!(a1, 1);
        assert_eq!(claim().map(|j| j.1), Some(3), "a.dev/2 waits; b.dev goes ahead");
        assert_eq!(claim(), None);
        s.finish_job(first, None).unwrap();
        assert_eq!(claim().map(|j| j.1), Some(2));
    }

    #[test]
    fn rendered_save_replaces_thin_extraction_and_reextract_keeps_ids() {
        let s = Store::open_in_memory().unwrap();
        let (id, _) = s.upsert_pending("https://example.com/post", "https://example.com/post", "example.com").unwrap();
        // Server HTML of a JS app: only a loading stub.
        store_fetched(&s, id, &page("<p>Loading the application, please wait for a moment.</p>")).unwrap();
        assert!(s.article_row(id).unwrap().unwrap().thin);

        let rendered = page(&BODY.repeat(3)).html;
        assert_eq!(save_rendered(&s, "https://example.com/post", rendered.clone()).unwrap(), id);
        let v = s.get_article(id, "ja").unwrap().unwrap();
        assert!(!v.article.thin && v.blocks.len() > 1, "{:?}", v.blocks);
        assert_eq!(s.latest_snapshot(id).unwrap().unwrap().html(), rendered);

        let ids: Vec<i64> = v.blocks.iter().map(|b| b.id).collect();
        assert_eq!(reextract(&s, id).unwrap(), id);
        let again: Vec<i64> = s.get_article(id, "ja").unwrap().unwrap().blocks.iter().map(|b| b.id).collect();
        assert_eq!(again, ids, "unchanged blocks keep their ids");
    }

    #[test]
    fn resaving_an_extracted_article_never_merges_it_away() {
        let s = Store::open_in_memory().unwrap();
        let (a, _) = s.upsert_pending("https://example.com/post", "https://example.com/post", "example.com").unwrap();
        store_fetched(&s, a, &page(BODY)).unwrap();
        let (b, _) = s.upsert_pending("https://example.com/b", "https://example.com/b", "example.com").unwrap();
        let no_canonical = page(BODY).html.replace(r#"<link rel="canonical" href="https://example.com/post?utm_source=feed">"#, "");
        store_fetched(&s, b, &Fetched { final_url: "https://example.com/b".into(), html: no_canonical, ..page(BODY) }).unwrap();
        s.add_tag(b, "keep").unwrap();
        // The rendered DOM of b now reveals a canonical equal to a.
        assert_eq!(save_rendered(&s, "https://example.com/b", page(&BODY.repeat(2)).html).unwrap(), b);
        let all = s.list_articles(&crate::store::ArticleFilter::All).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all.iter().find(|x| x.id == b).unwrap().tags, ["keep"]);
    }

    #[test]
    fn a_pdf_url_becomes_an_article_of_that_url() {
        let s = Store::open_in_memory().unwrap();
        let url = "https://arxiv.org/pdf/2401.00001";
        let (id, _) = s.upsert_pending(url, url, "arxiv.org").unwrap();
        let bytes = crate::pdf::tests::paper();
        store_fetch_result(&s, id, Ok(Resource::Pdf { final_url: url.into(), bytes: bytes.clone() })).unwrap();
        let a = s.article_row(id).unwrap().unwrap();
        assert_eq!((a.title.as_deref(), a.extraction_status.as_str(), a.pdf), (Some("Reading Order in Two Column Papers"), "ok", true));
        assert_eq!(s.latest_snapshot(id).unwrap().unwrap().body, bytes);
        assert_eq!(reextract(&s, id).unwrap(), id);
        assert_eq!(s.upsert_pending(url, url, "arxiv.org").unwrap(), (id, false), "saving it again finds it");

        let (short, _) = s.upsert_pending("https://a.dev/s.pdf", "https://a.dev/s.pdf", "a.dev").unwrap();
        let one_line = crate::pdf::tests::pdf(&[vec![(72., 100., 10., "A one-line poster.")]], None);
        store_fetch_result(&s, short, Ok(Resource::Pdf { final_url: "https://a.dev/s.pdf".into(), bytes: one_line })).unwrap();
        assert!(!s.article_row(short).unwrap().unwrap().thin, "a short PDF is not a JS page");
        assert!(!crate::render::enqueue_if_auto(&s, short).unwrap(), "a PDF is never rendered in a browser");

        let (bad, _) = s.upsert_pending("https://a.dev/x.pdf", "https://a.dev/x.pdf", "a.dev").unwrap();
        store_fetch_result(&s, bad, Ok(Resource::Pdf { final_url: "https://a.dev/x.pdf".into(), bytes: b"%PDF-1.4 broken".to_vec() })).unwrap();
        let a = s.article_row(bad).unwrap().unwrap();
        assert_eq!((a.fetch_status.as_str(), a.extraction_status.as_str(), a.pdf), ("ok", "failed", true), "kept to re-extract");
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
