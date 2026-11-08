//! URL -> fetch -> extract -> store. Failures are recorded on the article, not raised:
//! a failed article stays visible and saving the same URL again retries it.

use crate::extract::{EXTRACTION_VERSION, extract};
use crate::fetch::{Fetched, HttpClient, Resource, fetch_resource};
use crate::ir::BlockKind;
use crate::store::{Store, THIN_TEXT_CHARS};
use crate::url_norm::normalize;
use quick_xml::escape::escape;
use rusqlite::{OptionalExtension, params};
use ts_rs::TS;

pub const JOB_TYPE: &str = "ingest";

pub async fn save_url(store: &Store, client: &HttpClient, url: &str) -> Result<i64, String> {
    let norm = normalize(url)?;
    let domain = norm.host_str().unwrap_or_default().to_string();
    let (id, needs_work) = store.upsert_pending(url.trim(), norm.as_str(), &domain).map_err(|e| e.to_string())?;
    if !needs_work {
        return Ok(id);
    }
    // Through the queue though fetched here: if the app ends during the fetch, the job brings the article back
    // instead of leaving it 取得中 for good. Not claimed, a runner has it or this host is busy, and finds it saved.
    store.enqueue_job(JOB_TYPE, id, "{}", &format!("{JOB_TYPE}:{id}")).map_err(|e| e.to_string())?;
    let job = store.claim_article_job(&[JOB_TYPE], id).map_err(|e| e.to_string())?;
    let saved = crate::jobs::catch_panic(fetch_into(store, client, id, url.trim())).await;
    if let Some(job) = job {
        crate::jobs::finish(store, job.id, saved.as_ref().err().map(String::as_str)).await?;
    }
    saved
}

/// Background half of bulk import: fetches an article registered by `enqueue_urls`. A long queue
/// serialized per host can run this well after the user saved the page from the browser or the
/// palette: that save must stay, whatever the server answers now. So asked before and after the fetch.
pub async fn process(store: &Store, client: &HttpClient, article_id: i64) -> Result<i64, String> {
    let url = store.article_url(article_id).map_err(|e| e.to_string())?.ok_or("article no longer exists")?;
    if !store.needs_fetch(article_id).map_err(|e| e.to_string())? {
        return Ok(article_id);
    }
    let fetched = fetch_resource(client, &url).await;
    if !store.needs_fetch(article_id).map_err(|e| e.to_string())? {
        return Ok(article_id);
    }
    store_fetch_result(store, article_id, fetched)
}

/// A page that is refused (bot protection answers 403 to anything but a browser) or has no
/// text falls back to the feed entry's copy, when its feed carries one.
async fn fetch_into(store: &Store, client: &HttpClient, id: i64, url: &str) -> Result<i64, String> {
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

#[derive(Debug, Default, PartialEq, serde::Serialize, TS)]
#[ts(export)]
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
    while let Some(start) = rest.find("http") {
        let tail = &rest[start..];
        if !(tail.starts_with("https://") || tail.starts_with("http://")) {
            rest = &tail[4..];
            continue;
        }
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

/// Re-extracts an article that an older extractor read, from its stored page: what a newer one keeps (images inside
/// paragraphs, since version 3) reaches the articles saved before it. A local job: no network, and no paid work.
pub const REEXTRACT_JOB: &str = "reextract";
/// A re-extraction that keeps less of the text than this, in percent, keeps the article as it was.
const SHORTER_KEEPS_PERCENT: usize = 95;

/// At startup: every web page extracted by an older `EXTRACTION_VERSION`. Returns the number of jobs queued.
pub fn enqueue_outdated(store: &Store) -> Result<usize, String> {
    store
        .conn()
        .execute(
            "INSERT INTO processing_jobs (type, article_id, params, dedup_key)
             SELECT ?1, id, '{}', ?1 || ':' || id FROM articles WHERE extraction_status = 'ok' AND extraction_version < ?2
             ON CONFLICT(dedup_key) DO UPDATE SET status = 'pending', attempt_count = 0, last_error = NULL, next_run_at = NULL
             WHERE status IN ('succeeded', 'failed')",
            params![REEXTRACT_JOB, EXTRACTION_VERSION],
        )
        .map_err(|e| e.to_string())
}

/// The job. A page that does not read now (gone, damaged, or no longer extracting) keeps the article as it is: what it
/// has is better than nothing, and trying again would not change that. PDFs and Markdown have extractors of their own,
/// which this version says nothing about.
pub fn reextract_outdated(store: &Store, id: i64) -> Result<(), String> {
    let err = |e: rusqlite::Error| e.to_string();
    let keep_as_is =
        || store.conn().execute("UPDATE articles SET extraction_version = ?2 WHERE id = ?1", params![id, EXTRACTION_VERSION]).map(drop).map_err(err);
    let snap = match store.latest_snapshot(id) {
        Ok(snap) => snap,
        // A page that cannot be decoded will not decode next time. Anything else (the CLI holding the database) is tried again.
        Err(rusqlite::Error::FromSqlConversionFailure(..)) => None,
        Err(e) => return Err(e.to_string()),
    };
    let snap = snap.filter(|s| s.content_type.as_deref() != Some(crate::pdf::CONTENT_TYPE) && !crate::markdown::is_local(&s.final_url));
    let from_feed = snap.as_ref().is_some_and(|s| s.content_type.as_deref() == Some(FEED_CONTENT_TYPE));
    let Some(ir) = snap.and_then(|s| extract(&s.html(), &s.final_url).ok()) else {
        return keep_as_is();
    };
    let (prose_before, hash_before, error_before) = {
        let c = store.conn();
        let mut st = c.prepare("SELECT text FROM blocks WHERE article_id = ?1 AND kind != 'image' ORDER BY ordinal").map_err(err)?;
        let prose = st.query_map([id], |r| r.get::<_, String>(0)).map_err(err)?.collect::<Result<Vec<_>, _>>().map_err(err)?;
        let (hash, error): (String, Option<String>) =
            c.query_row("SELECT content_hash, last_error FROM articles WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(err)?;
        (prose, hash, error)
    };
    let prose_after: Vec<&str> = ir.blocks.iter().filter(|b| b.kind != BlockKind::Image).map(|b| b.text.as_str()).collect();
    // A newer extractor that reads this page shorter would take paragraphs away, and their translations, notes and
    // citations with them: what the article has stays.
    let chars = |texts: &mut dyn Iterator<Item = &str>| texts.map(|t| t.chars().count()).sum::<usize>();
    if chars(&mut prose_after.iter().copied()) * 100 < chars(&mut prose_before.iter().map(String::as_str)) * SHORTER_KEEPS_PERCENT {
        return keep_as_is();
    }
    let prose_same = prose_after.iter().copied().eq(prose_before.iter().map(String::as_str));
    let canonical = ir.meta.canonical_url.as_deref().and_then(|c| normalize(c).ok()).map(String::from);
    store.save_fetched(id, None, Ok(ir), canonical.as_deref()).map_err(|e| e.to_string())?;
    // Saving clears these as a new fetch should. Here the text is what it was: a summary or quiz of it is not out of
    // date for the images found in it, and an article read from its feed still could not fetch its page.
    store
        .conn()
        .execute(
            "UPDATE articles SET content_hash = CASE WHEN ?2 THEN ?3 ELSE content_hash END, last_error = CASE WHEN ?4 THEN ?5 ELSE last_error END
             WHERE id = ?1",
            params![id, prose_same, hash_before, from_feed, error_before],
        )
        .map_err(err)?;
    crate::images::enqueue(store, id)?;
    Ok(())
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
    fn extracts_http_and_https_in_order_past_bare_words() {
        let text = "http://a.dev/1 says http is fine https://b.dev/2 httpd http://c.dev/3 http://a.dev/1";
        assert_eq!(extract_urls(text), ["http://a.dev/1", "https://b.dev/2", "http://c.dev/3"]);
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

        // A short page reads alike on every URL (a paywall, a JS app's stub): its canonical does not merge it.
        let (stub, _) = s.upsert_pending("https://example.com/stub", "https://example.com/stub", "example.com").unwrap();
        assert_eq!(store_fetched(&s, stub, &page(BODY)).unwrap(), stub);
    }

    #[test]
    fn a_different_url_with_the_same_text_collapses_into_the_article_its_canonical_names() {
        let s = Store::open_in_memory().unwrap();
        let long: String = (0..5)
            .map(|n| format!("<p>Paragraph {n} says snapshot isolation prevents dirty reads but still permits write skew, which is why SSI exists.</p>"))
            .collect();
        let (id, _) = s.upsert_pending("https://example.com/post", "https://example.com/post", "example.com").unwrap();
        assert_eq!(store_fetched(&s, id, &page(&long)).unwrap(), id);

        let (other, _) = s.upsert_pending("https://example.com/p?id=1", "https://example.com/p?id=1", "example.com").unwrap();
        assert_eq!(store_fetched(&s, other, &page(&format!("{long}<p>A related post sits at the end of this copy.</p>"))).unwrap(), id);
        assert_eq!(s.list_articles(&crate::store::ArticleFilter::All).unwrap().len(), 1);
        assert_eq!(s.find_article_by_url("https://example.com/p?id=1").unwrap(), None, "the row is gone");

        // The same canonical on a page of other text is a site's mistake, not a copy.
        let (third, _) = s.upsert_pending("https://example.com/third", "https://example.com/third", "example.com").unwrap();
        let different: String = (0..5)
            .map(|n| format!("<p>Section {n} of another post is about how a B-tree page splits when it fills up, with a worked example and numbers.</p>"))
            .collect();
        assert_eq!(store_fetched(&s, third, &page(&different)).unwrap(), third);
        assert_eq!(s.find_article_by_url("https://example.com/third").unwrap(), Some(third));
        assert_eq!(s.find_article_by_url("https://example.com/post").unwrap(), Some(id), "the URL's own article, not the other that names it");
    }

    #[tokio::test]
    async fn saving_a_url_leaves_a_job_that_outlives_the_app() {
        let s = Store::open_in_memory().unwrap();
        let client = crate::fetch::client();
        // The app ends during the fetch: the future is dropped where it waits.
        let mut saving = Box::pin(save_url(&s, &client, "https://example.com/post"));
        assert!(futures::poll!(&mut saving).is_pending());
        drop(saving);
        let v = s.get_article(1, "ja").unwrap().unwrap();
        assert_eq!((v.article.fetch_status.as_str(), v.jobs[0].job_type.as_str(), v.jobs[0].status.as_str()), ("pending", JOB_TYPE, "running"));
    }

    #[tokio::test]
    async fn saving_a_url_finishes_its_job() {
        let s = Store::open_in_memory().unwrap();
        // The default network policy refuses it at once: nothing is sent, and the refusal is recorded on the article.
        let id = save_url(&s, &crate::fetch::client(), "http://127.0.0.1:9/post").await.unwrap();
        let v = s.get_article(id, "ja").unwrap().unwrap();
        assert_eq!((v.article.fetch_status.as_str(), v.jobs[0].status.as_str()), ("failed", "succeeded"));
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
    fn an_article_an_older_extractor_read_is_read_again_from_its_page() {
        let s = Store::open_in_memory().unwrap();
        let (id, _) = s.upsert_pending("https://example.com/post", "https://example.com/post", "example.com").unwrap();
        let with_image = format!("{BODY}<p><img src=\"/fig.png\" alt=\"A figure\"></p>");
        store_fetched(&s, id, &page(&with_image)).unwrap();
        // As version 2 stored it: no image block.
        s.conn().execute("DELETE FROM blocks WHERE article_id = ?1 AND kind = 'image'", [id]).unwrap();
        s.conn().execute("UPDATE articles SET extraction_version = 2 WHERE id = ?1", [id]).unwrap();
        let (shorter, _) = s.upsert_pending("https://example.com/shorter", "https://example.com/shorter", "example.com").unwrap();
        // Its stored page reads as a third of what the article holds.
        store_fetched(&s, shorter, &page(BODY)).unwrap();
        let held = extract(&page(&BODY.repeat(3)).html, "https://example.com/shorter").unwrap();
        s.save_fetched(shorter, None, Ok(held), None).unwrap();
        s.conn().execute("UPDATE articles SET extraction_version = 2 WHERE id = ?1", [shorter]).unwrap();
        let long = s.get_article(shorter, "ja").unwrap().unwrap().blocks.len();
        let (gone, _) = s.upsert_pending("https://example.com/gone", "https://example.com/gone", "example.com").unwrap();
        store_fetched(&s, gone, &page(BODY)).unwrap();
        s.conn().execute("UPDATE articles SET extraction_version = 2 WHERE id = ?1", [gone]).unwrap();
        s.conn().execute("UPDATE snapshots SET body = x'' WHERE article_id = ?1", [gone]).unwrap();
        let kept = s.get_article(gone, "ja").unwrap().unwrap().blocks.len();

        // Its hash then was of the text alone, and a summary made since records it.
        let hash = "hash of the text alone";
        s.conn().execute("UPDATE articles SET content_hash = ?2 WHERE id = ?1", params![id, hash]).unwrap();

        assert_eq!(enqueue_outdated(&s).unwrap(), 3);
        assert_eq!(enqueue_outdated(&s).unwrap(), 0, "once");
        reextract_outdated(&s, id).unwrap();
        let after: String = s.conn().query_row("SELECT content_hash FROM articles WHERE id = ?1", [id], |r| r.get(0)).unwrap();
        assert_eq!(after, hash, "the text is unchanged: a summary of it (by this hash) is not out of date for the image found in it");
        let blocks = s.get_article(id, "ja").unwrap().unwrap().blocks;
        assert!(blocks.iter().any(|b| b.block.kind == crate::ir::BlockKind::Image && b.block.text == "A figure"), "{blocks:?}");
        reextract_outdated(&s, shorter).unwrap();
        assert_eq!(s.get_article(shorter, "ja").unwrap().unwrap().blocks.len(), long, "a page read shorter keeps what the article has");
        reextract_outdated(&s, gone).unwrap();
        assert_eq!(s.get_article(gone, "ja").unwrap().unwrap().blocks.len(), kept, "a page that no longer reads keeps the article as it was");
        let versions: Vec<i64> =
            s.conn().prepare("SELECT extraction_version FROM articles").unwrap().query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
        assert_eq!(versions, [EXTRACTION_VERSION; 3]);
    }

    #[test]
    fn an_article_read_from_its_feed_keeps_its_page_error_when_read_again() {
        let s = Store::open_in_memory().unwrap();
        let (id, _) = s.upsert_pending("https://example.com/post", "https://example.com/post", "example.com").unwrap();
        let feed = Fetched { content_type: Some(FEED_CONTENT_TYPE.into()), ..page(BODY) };
        store_fetched(&s, id, &feed).unwrap();
        s.conn().execute("UPDATE articles SET extraction_version = 2, last_error = 'HTTP 403' WHERE id = ?1", [id]).unwrap();
        reextract_outdated(&s, id).unwrap();
        let error: Option<String> = s.conn().query_row("SELECT last_error FROM articles WHERE id = ?1", [id], |r| r.get(0)).unwrap();
        assert_eq!(error.as_deref(), Some("HTTP 403"));
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
