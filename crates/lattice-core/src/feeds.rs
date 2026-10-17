//! RSS / Atom collector (§13): feed -> unseen entry URLs -> the bulk-import path
//! (`ingest::enqueue_urls`, background ingest jobs). Kept apart from the UI and the job queue:
//! a poll only registers URLs, fetching the articles is the network runners' job.

use std::time::Duration;

use rusqlite::{OptionalExtension, params};
use serde::Serialize;

use crate::fetch::HttpClient;
use crate::ingest;
use crate::store::Store;
use crate::url_norm::normalize;

pub const POLL_INTERVAL: Duration = Duration::from_secs(30 * 60);
/// Entries imported on the first fetch of a feed; older ones are only marked seen,
/// so subscribing to a blog with a full-archive feed does not import hundreds of posts.
pub const FIRST_IMPORT: usize = 20;
const MAX_BODY: usize = 10 * 1024 * 1024;

fn err(e: impl ToString) -> String {
    e.to_string()
}

#[derive(Debug, Serialize)]
pub struct FeedRow {
    pub id: i64,
    pub url: String,
    pub title: Option<String>,
    pub site_url: Option<String>,
    pub last_fetched_at: Option<String>,
    pub last_error: Option<String>,
    pub article_count: i64,
}

#[derive(Debug, Default, PartialEq)]
pub struct Parsed {
    pub title: Option<String>,
    pub site_url: Option<String>,
    /// Entry URLs, newest first.
    pub entries: Vec<String>,
}

pub fn parse(body: &[u8], feed_url: &str) -> Result<Parsed, String> {
    let feed = feed_rs::parser::Builder::new()
        .base_uri(Some(feed_url))
        .build()
        .parse(body)
        .map_err(|e| format!("not an RSS/Atom feed: {e}"))?;
    let alternate = |links: &[feed_rs::model::Link]| {
        links.iter().find(|l| l.rel.as_deref().is_none_or(|r| r == "alternate")).map(|l| l.href.clone())
    };
    let mut entries = feed.entries;
    entries.sort_by_key(|e| std::cmp::Reverse(e.published.or(e.updated))); // stable: undated keep feed order
    Ok(Parsed {
        title: feed.title.map(|t| t.content.trim().to_string()).filter(|t| !t.is_empty()),
        site_url: alternate(&feed.links),
        entries: entries
            .iter()
            .filter_map(|e| alternate(&e.links).or_else(|| e.links.first().map(|l| l.href.clone())).or_else(|| e.id.starts_with("http").then(|| e.id.clone())))
            .filter(|u| u.starts_with("https://") || u.starts_with("http://"))
            .collect(),
    })
}

/// Returns the feed id and whether it is new.
pub fn add(store: &Store, url: &str) -> Result<(i64, bool), String> {
    let url = url.trim();
    let parsed = url::Url::parse(url).map_err(|e| format!("invalid URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("only http(s) feeds are supported".into());
    }
    let c = store.conn();
    let created = c.execute("INSERT INTO feeds (url) VALUES (?1) ON CONFLICT(url) DO NOTHING", [url]).map_err(err)? == 1;
    let id = c.query_row("SELECT id FROM feeds WHERE url = ?1", [url], |r| r.get(0)).map_err(err)?;
    Ok((id, created))
}

pub fn remove(store: &Store, id: i64) -> Result<(), String> {
    store.conn().execute("DELETE FROM feeds WHERE id = ?1", [id]).map(drop).map_err(err)
}

pub fn list(store: &Store) -> Result<Vec<FeedRow>, String> {
    let c = store.conn();
    let mut st = c
        .prepare(
            "SELECT id, url, title, site_url, last_fetched_at, last_error, (SELECT count(*) FROM articles WHERE feed_id = feeds.id)
             FROM feeds ORDER BY coalesce(title, url) COLLATE NOCASE",
        )
        .map_err(err)?;
    st.query_map([], |r| {
        Ok(FeedRow {
            id: r.get(0)?,
            url: r.get(1)?,
            title: r.get(2)?,
            site_url: r.get(3)?,
            last_fetched_at: r.get(4)?,
            last_error: r.get(5)?,
            article_count: r.get(6)?,
        })
    })
    .map_err(err)?
    .collect::<Result<_, _>>()
    .map_err(err)
}

/// Fetches one feed and queues its unseen entries. Returns how many articles were queued.
/// Failures are recorded on the feed as well as returned.
pub async fn refresh(store: &Store, client: &HttpClient, id: i64) -> Result<usize, String> {
    let row: Option<(String, Option<String>, Option<String>)> = store
        .conn()
        .query_row("SELECT url, etag, last_modified FROM feeds WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()
        .map_err(err)?;
    let Some((url, etag, modified)) = row else { return Err("feed no longer exists".into()) };
    let result = match fetch(client, &url, etag.as_deref(), modified.as_deref()).await {
        Ok(None) => mark_fetched(store, id, None, None, None).map(|_| 0),
        Ok(Some((body, etag, modified))) => parse(&body, &url).and_then(|p| {
            let queued = import(store, id, &p.entries)?;
            mark_fetched(store, id, Some(&p), etag.as_deref(), modified.as_deref())?;
            Ok(queued)
        }),
        Err(e) => Err(e),
    };
    if let Err(e) = &result {
        store.conn().execute("UPDATE feeds SET last_error = ?2 WHERE id = ?1", params![id, e]).map_err(err)?;
    }
    result
}

/// Refreshes every feed; one failing feed never stops the others. Returns articles queued.
pub async fn refresh_all(store: &Store, client: &HttpClient) -> usize {
    let ids: Vec<i64> = match list(store) {
        Ok(feeds) => feeds.iter().map(|f| f.id).collect(),
        Err(e) => {
            log::error!("feeds: {e}");
            return 0;
        }
    };
    let mut queued = 0;
    for id in ids {
        match refresh(store, client, id).await {
            Ok(n) => queued += n,
            Err(e) => log::warn!("feed {id}: {e}"),
        }
    }
    queued
}

/// Startup poll, then every `POLL_INTERVAL`. `on_polled(queued)` lets the app wake fetchers.
pub async fn poll_forever(store: std::sync::Arc<Store>, client: HttpClient, on_polled: impl Fn(usize)) {
    loop {
        on_polled(refresh_all(&store, &client).await);
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// Network-free half of a refresh: queues entries this feed has not listed before.
pub fn import(store: &Store, feed_id: i64, entries: &[String]) -> Result<usize, String> {
    let first: bool = !store
        .conn()
        .query_row("SELECT EXISTS (SELECT 1 FROM feed_items WHERE feed_id = ?1)", [feed_id], |r| r.get(0))
        .map_err(err)?;
    let mut unseen: Vec<(String, String)> = Vec::new();
    {
        let c = store.conn();
        let mut seen = c.prepare("SELECT 1 FROM feed_items WHERE feed_id = ?1 AND normalized_url = ?2").map_err(err)?;
        for url in entries {
            let Ok(norm) = normalize(url) else { continue };
            let norm = norm.to_string();
            if !unseen.iter().any(|(_, n)| *n == norm) && !seen.exists(params![feed_id, norm]).map_err(err)? {
                unseen.push((url.clone(), norm));
            }
        }
    }
    let take = if first { FIRST_IMPORT } else { unseen.len() };
    let urls: Vec<String> = unseen.iter().take(take).map(|(u, _)| u.clone()).collect();
    let summary = ingest::enqueue_urls(store, &urls)?;
    let norms: Vec<&str> = unseen.iter().map(|(_, n)| n.as_str()).collect();
    let norms = serde_json::to_string(&norms).expect("strings serialize");
    // Marked seen only after queueing, so a crash in between re-imports rather than loses entries.
    let c = store.conn();
    c.execute(
        "UPDATE articles SET feed_id = ?1 WHERE feed_id IS NULL AND normalized_url IN (SELECT value FROM json_each(?2))",
        params![feed_id, norms],
    )
    .map_err(err)?;
    c.execute(
        "INSERT OR IGNORE INTO feed_items (feed_id, normalized_url) SELECT ?1, value FROM json_each(?2)",
        params![feed_id, norms],
    )
    .map_err(err)?;
    Ok(summary.queued)
}

fn mark_fetched(store: &Store, id: i64, p: Option<&Parsed>, etag: Option<&str>, modified: Option<&str>) -> Result<(), String> {
    store
        .conn()
        .execute(
            "UPDATE feeds SET last_error = NULL, last_fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             title = coalesce(?2, title), site_url = coalesce(?3, site_url),
             etag = CASE WHEN ?6 THEN ?4 ELSE etag END, last_modified = CASE WHEN ?6 THEN ?5 ELSE last_modified END
             WHERE id = ?1",
            params![id, p.and_then(|p| p.title.as_deref()), p.and_then(|p| p.site_url.as_deref()), etag, modified, p.is_some()],
        )
        .map(drop)
        .map_err(err)
}

/// `Ok(None)` when the server answers 304 Not Modified.
async fn fetch(client: &HttpClient, url: &str, etag: Option<&str>, modified: Option<&str>) -> Result<Option<(Vec<u8>, Option<String>, Option<String>)>, String> {
    use reqwest::header::{ETAG, IF_MODIFIED_SINCE, IF_NONE_MATCH, LAST_MODIFIED};
    let mut req = client.get(url);
    if let Some(e) = etag {
        req = req.header(IF_NONE_MATCH, e);
    }
    if let Some(m) = modified {
        req = req.header(IF_MODIFIED_SINCE, m);
    }
    let mut resp = req.send().await.map_err(|e| format!("request failed: {e}"))?;
    if resp.status() == reqwest::StatusCode::NOT_MODIFIED {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let header = |n: reqwest::header::HeaderName| resp.headers().get(n).and_then(|v| v.to_str().ok()).map(str::to_string);
    let (etag, modified) = (header(ETAG), header(LAST_MODIFIED));
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("read failed: {e}"))? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_BODY {
            return Err(format!("feed exceeds {MAX_BODY} bytes"));
        }
    }
    Ok(Some((body, etag, modified)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::ArticleFilter;

    const RSS: &str = r#"<?xml version="1.0"?><rss version="2.0"><channel><title> Tech Blog </title><link>https://blog.dev/</link>
        <item><title>Old</title><link>https://blog.dev/old?utm_source=rss</link><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
        <item><title>New</title><link>https://blog.dev/new</link><pubDate>Tue, 01 Oct 2024 00:00:00 GMT</pubDate></item>
        <item><title>Guid only</title><guid isPermaLink="true">https://blog.dev/guid</guid></item>
        </channel></rss>"#;

    const ATOM: &str = r#"<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title>
        <link rel="self" href="https://a.dev/feed.xml"/><link href="https://a.dev/"/>
        <entry><title>E</title><id>tag:a.dev,2024:1</id><link rel="alternate" href="/posts/1"/><updated>2024-05-01T00:00:00Z</updated></entry>
        </feed>"#;

    #[test]
    fn parses_rss_and_atom() {
        let p = parse(RSS.as_bytes(), "https://blog.dev/feed").unwrap();
        assert_eq!(p.title.as_deref(), Some("Tech Blog"));
        assert_eq!(p.site_url.as_deref(), Some("https://blog.dev/"));
        assert_eq!(p.entries, ["https://blog.dev/new", "https://blog.dev/old?utm_source=rss", "https://blog.dev/guid"]);
        let a = parse(ATOM.as_bytes(), "https://a.dev/feed.xml").unwrap();
        assert_eq!((a.site_url.as_deref(), a.entries.as_slice()), (Some("https://a.dev/"), ["https://a.dev/posts/1".to_string()].as_slice()));
        assert!(parse(b"<html><body>no feed</body></html>", "https://x.dev/").is_err());
    }

    #[test]
    fn imports_only_unseen_entries_and_caps_first_import() {
        let s = Store::open_in_memory().unwrap();
        assert!(add(&s, "file:///etc/passwd").is_err());
        let (id, created) = add(&s, "https://blog.dev/feed").unwrap();
        assert!(created && !add(&s, " https://blog.dev/feed ").unwrap().1);

        let entries: Vec<String> = (0..FIRST_IMPORT + 5).map(|i| format!("https://blog.dev/p{i}")).collect();
        assert_eq!(import(&s, id, &entries).unwrap(), FIRST_IMPORT, "newest entries only");
        assert_eq!(import(&s, id, &entries).unwrap(), 0, "older entries skipped on first import stay skipped");
        let mut more = vec!["https://blog.dev/fresh?utm_source=rss".to_string()];
        more.extend(entries);
        assert_eq!(import(&s, id, &more).unwrap(), 1);

        let rows = s.list_articles(&ArticleFilter::All).unwrap();
        assert_eq!(rows.len(), FIRST_IMPORT + 1);
        assert!(rows.iter().all(|a| a.feed_id == Some(id) && a.feed_title.as_deref() == Some("https://blog.dev/feed")));
        assert_eq!(list(&s).unwrap()[0].article_count, FIRST_IMPORT as i64 + 1);

        remove(&s, id).unwrap();
        let rows = s.list_articles(&ArticleFilter::All).unwrap();
        assert_eq!(rows.len(), FIRST_IMPORT + 1, "articles survive their feed");
        assert!(rows.iter().all(|a| a.feed_id.is_none()));
    }
}
