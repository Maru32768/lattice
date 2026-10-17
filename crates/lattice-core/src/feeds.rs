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
    /// Newest first.
    pub entries: Vec<Entry>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub url: String,
    /// Published (else updated) date, UTC ISO 8601: fills `articles.published_at` when the page has none.
    pub published: Option<String>,
}

/// A feed found on a page (autodiscovery), or the URL itself when it is one.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Candidate {
    pub url: String,
    pub title: Option<String>,
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
            .filter_map(|e| {
                let url = alternate(&e.links).or_else(|| e.links.first().map(|l| l.href.clone())).or_else(|| e.id.starts_with("http").then(|| e.id.clone()))?;
                let published = e.published.or(e.updated).map(|d| d.format("%Y-%m-%dT%H:%M:%SZ").to_string());
                Some(Entry { url, published })
            })
            .filter(|e| e.url.starts_with("https://") || e.url.starts_with("http://"))
            .collect(),
    })
}

const FEED_TYPES: [&str; 3] = ["application/rss+xml", "application/atom+xml", "application/feed+json"];
/// Tried only when a page links no feed.
const COMMON_PATHS: [&str; 4] = ["/feed", "/rss.xml", "/atom.xml", "/index.xml"];

/// `<link rel="alternate" type="…rss/atom/feed+json" href>` on a page, hrefs resolved against `base`.
pub fn feed_links(html: &str, base: &str) -> Vec<Candidate> {
    let Ok(base) = url::Url::parse(base) else { return Vec::new() };
    let doc = dom_query::Document::from(html);
    let mut out: Vec<Candidate> = Vec::new();
    for link in doc.select("link[href]").iter() {
        let attr = |n: &str| link.attr(n).map(|v| v.trim().to_ascii_lowercase()).unwrap_or_default();
        if !attr("rel").split_ascii_whitespace().any(|r| r == "alternate") || !FEED_TYPES.contains(&attr("type").as_str()) {
            continue;
        }
        let Some(url) = link.attr("href").and_then(|h| base.join(h.trim()).ok()) else { continue };
        if matches!(url.scheme(), "http" | "https") && !out.iter().any(|c| c.url == url.as_str()) {
            let title = link.attr("title").map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
            out.push(Candidate { url: url.to_string(), title });
        }
    }
    out
}

/// Feeds for a URL the user typed: the URL itself if it is a feed, else the feeds its page
/// links, else the first common feed path on its host that parses. Empty when none is found.
pub async fn discover(client: &HttpClient, url: &str) -> Result<Vec<Candidate>, String> {
    let url = url.trim();
    let got = fetch(client, url, None, None).await?.ok_or("unexpected 304")?;
    if let Ok(p) = parse(&got.body, &got.url) {
        return Ok(vec![Candidate { url: url.to_string(), title: p.title }]);
    }
    let links = feed_links(&String::from_utf8_lossy(&got.body), &got.url);
    if !links.is_empty() {
        return Ok(links);
    }
    let base = url::Url::parse(&got.url).map_err(err)?;
    for path in COMMON_PATHS {
        let Ok(u) = base.join(path) else { continue };
        if let Ok(Some(g)) = fetch(client, u.as_str(), None, None).await {
            if let Ok(p) = parse(&g.body, u.as_str()) {
                return Ok(vec![Candidate { url: u.to_string(), title: p.title }]);
            }
        }
    }
    Ok(Vec::new())
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
        Ok(Some(g)) => parse(&g.body, &url).and_then(|p| {
            let queued = import(store, id, &p.entries)?;
            mark_fetched(store, id, Some(&p), g.etag.as_deref(), g.modified.as_deref())?;
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
pub fn import(store: &Store, feed_id: i64, entries: &[Entry]) -> Result<usize, String> {
    let first: bool = !store
        .conn()
        .query_row("SELECT EXISTS (SELECT 1 FROM feed_items WHERE feed_id = ?1)", [feed_id], |r| r.get(0))
        .map_err(err)?;
    let mut unseen: Vec<(&Entry, String)> = Vec::new();
    {
        let c = store.conn();
        let mut seen = c.prepare("SELECT 1 FROM feed_items WHERE feed_id = ?1 AND normalized_url = ?2").map_err(err)?;
        for e in entries {
            let Ok(norm) = normalize(&e.url) else { continue };
            let norm = norm.to_string();
            if !unseen.iter().any(|(_, n)| *n == norm) && !seen.exists(params![feed_id, norm]).map_err(err)? {
                unseen.push((e, norm));
            }
        }
    }
    let take = if first { FIRST_IMPORT } else { unseen.len() };
    let urls: Vec<String> = unseen.iter().take(take).map(|(e, _)| e.url.clone()).collect();
    let summary = ingest::enqueue_urls(store, &urls)?;
    let items: Vec<serde_json::Value> = unseen.iter().map(|(e, n)| serde_json::json!({"u": n, "p": e.published})).collect();
    let items = serde_json::to_string(&items).expect("json serializes");
    // Marked seen only after queueing, so a crash in between re-imports rather than loses entries.
    let c = store.conn();
    c.execute(
        "UPDATE articles SET feed_id = ?1 WHERE feed_id IS NULL AND normalized_url IN (SELECT value ->> 'u' FROM json_each(?2))",
        params![feed_id, items],
    )
    .map_err(err)?;
    c.execute(
        "INSERT OR IGNORE INTO feed_items (feed_id, normalized_url, published_at) SELECT ?1, value ->> 'u', value ->> 'p' FROM json_each(?2)",
        params![feed_id, items],
    )
    .map_err(err)?;
    // Already extracted without a date; articles still queued get it in `save_fetched`.
    c.execute(
        "UPDATE articles SET published_at = (SELECT value ->> 'p' FROM json_each(?1) WHERE value ->> 'u' = articles.normalized_url)
         WHERE published_at IS NULL AND extraction_status = 'ok'
           AND normalized_url IN (SELECT value ->> 'u' FROM json_each(?1) WHERE value ->> 'p' IS NOT NULL)",
        [&items],
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

struct Got {
    body: Vec<u8>,
    /// After redirects.
    url: String,
    etag: Option<String>,
    modified: Option<String>,
}

/// `Ok(None)` when the server answers 304 Not Modified.
async fn fetch(client: &HttpClient, url: &str, etag: Option<&str>, modified: Option<&str>) -> Result<Option<Got>, String> {
    use reqwest::header::{ETAG, IF_MODIFIED_SINCE, IF_NONE_MATCH, LAST_MODIFIED};
    crate::fetch::check_public(url)?;
    let mut req = client.get(url);
    if let Some(e) = etag {
        req = req.header(IF_NONE_MATCH, e);
    }
    if let Some(m) = modified {
        req = req.header(IF_MODIFIED_SINCE, m);
    }
    let mut resp = req.send().await.map_err(crate::fetch::request_error)?;
    if resp.status() == reqwest::StatusCode::NOT_MODIFIED {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let header = |n: reqwest::header::HeaderName| resp.headers().get(n).and_then(|v| v.to_str().ok()).map(str::to_string);
    let (etag, modified, final_url) = (header(ETAG), header(LAST_MODIFIED), resp.url().to_string());
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("read failed: {e}"))? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_BODY {
            return Err(format!("feed exceeds {MAX_BODY} bytes"));
        }
    }
    Ok(Some(Got { body, url: final_url, etag, modified }))
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

    fn urls(p: &Parsed) -> Vec<&str> {
        p.entries.iter().map(|e| e.url.as_str()).collect()
    }

    fn entry(url: &str) -> Entry {
        Entry { url: url.to_string(), published: None }
    }

    #[test]
    fn parses_rss_and_atom() {
        let p = parse(RSS.as_bytes(), "https://blog.dev/feed").unwrap();
        assert_eq!(p.title.as_deref(), Some("Tech Blog"));
        assert_eq!(p.site_url.as_deref(), Some("https://blog.dev/"));
        assert_eq!(urls(&p), ["https://blog.dev/new", "https://blog.dev/old?utm_source=rss", "https://blog.dev/guid"]);
        assert_eq!(p.entries[0].published.as_deref(), Some("2024-10-01T00:00:00Z"));
        assert_eq!(p.entries[2].published, None);
        let a = parse(ATOM.as_bytes(), "https://a.dev/feed.xml").unwrap();
        assert_eq!((a.site_url.as_deref(), urls(&a)), (Some("https://a.dev/"), vec!["https://a.dev/posts/1"]));
        assert_eq!(a.entries[0].published.as_deref(), Some("2024-05-01T00:00:00Z"), "updated when not published");
        assert!(parse(b"<html><body>no feed</body></html>", "https://x.dev/").is_err());
    }

    #[test]
    fn finds_feed_links_on_a_page() {
        let html = r#"<html><head>
            <link rel="stylesheet" href="/style.css">
            <link rel="alternate" type="application/rss+xml" title=" Posts " href="/feed.xml">
            <link rel="Alternate" type="Application/Atom+XML" href="atom.xml">
            <link rel="alternate" type="application/feed+json" href="https://cdn.blog.dev/feed.json">
            <link rel="alternate" type="application/rss+xml" href="/feed.xml">
            <link rel="alternate" hreflang="en" href="/en/">
            <link rel="alternate" type="application/rss+xml" href="javascript:alert(1)">
            </head><body><a href="/other.rss" type="application/rss+xml">rss</a></body></html>"#;
        let found = feed_links(html, "https://blog.dev/posts/1");
        assert_eq!(
            found,
            [
                Candidate { url: "https://blog.dev/feed.xml".into(), title: Some("Posts".into()) },
                Candidate { url: "https://blog.dev/posts/atom.xml".into(), title: None },
                Candidate { url: "https://cdn.blog.dev/feed.json".into(), title: None },
            ]
        );
        assert!(feed_links("<html><head><title>x</title></head></html>", "https://blog.dev/").is_empty());
    }

    #[test]
    fn entry_dates_fill_missing_published_at() {
        use crate::fetch::Fetched;
        let s = Store::open_in_memory().unwrap();
        let page = |url: &str, meta: &str| Fetched {
            final_url: url.to_string(),
            status: 200,
            content_type: None,
            html: format!("<html><head><title>T</title>{meta}</head><body><article><p>Snapshot isolation permits write skew, which serializable snapshot isolation prevents at commit time. This sentence pads the paragraph so readability keeps it.</p></article></body></html>"),
        };
        // Saved by hand before the feed listed it: filled at import.
        assert_eq!(ingest::enqueue_urls(&s, &["https://blog.dev/early".to_string()]).unwrap().queued, 1);
        let early_id = s.list_articles(&ArticleFilter::All).unwrap()[0].id;
        ingest::store_fetched(&s, early_id, &page("https://blog.dev/early", "")).unwrap();

        let (feed, _) = add(&s, "https://blog.dev/feed").unwrap();
        let dated = |url: &str, d: &str| Entry { url: url.to_string(), published: Some(d.to_string()) };
        let entries = [
            dated("https://blog.dev/early", "2024-01-01T00:00:00Z"),
            dated("https://blog.dev/plain", "2024-02-01T00:00:00Z"),
            dated("https://blog.dev/meta", "2024-03-01T00:00:00Z"),
        ];
        import(&s, feed, &entries).unwrap();
        let rows = s.list_articles(&ArticleFilter::All).unwrap();
        let id_of = |u: &str| rows.iter().find(|a| a.original_url == u).unwrap().id;
        ingest::store_fetched(&s, id_of("https://blog.dev/plain"), &page("https://blog.dev/plain", "")).unwrap();
        let meta = r#"<meta property="article:published_time" content="2023-12-24T10:00:00+09:00">"#;
        ingest::store_fetched(&s, id_of("https://blog.dev/meta"), &page("https://blog.dev/meta", meta)).unwrap();

        let published = |u: &str| s.article_row(id_of(u)).unwrap().unwrap().published_at;
        assert_eq!(published("https://blog.dev/early").as_deref(), Some("2024-01-01T00:00:00Z"));
        assert_eq!(published("https://blog.dev/plain").as_deref(), Some("2024-02-01T00:00:00Z"));
        assert_eq!(published("https://blog.dev/meta").as_deref(), Some("2023-12-24T10:00:00+09:00"), "the page's own date wins");
    }

    #[test]
    fn imports_only_unseen_entries_and_caps_first_import() {
        let s = Store::open_in_memory().unwrap();
        assert!(add(&s, "file:///etc/passwd").is_err());
        let (id, created) = add(&s, "https://blog.dev/feed").unwrap();
        assert!(created && !add(&s, " https://blog.dev/feed ").unwrap().1);

        let entries: Vec<Entry> = (0..FIRST_IMPORT + 5).map(|i| entry(&format!("https://blog.dev/p{i}"))).collect();
        assert_eq!(import(&s, id, &entries).unwrap(), FIRST_IMPORT, "newest entries only");
        assert_eq!(import(&s, id, &entries).unwrap(), 0, "older entries skipped on first import stay skipped");
        let mut more = vec![entry("https://blog.dev/fresh?utm_source=rss")];
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
