//! RSS / Atom collector (§13): feed -> unseen entry URLs -> the bulk-import path
//! (`ingest::enqueue_urls`, background ingest jobs). Kept apart from the UI and the job queue:
//! a poll only registers URLs, fetching the articles is the network runners' job.

use std::time::Duration;

use rusqlite::{OptionalExtension, params};
use serde::Serialize;

use crate::fetch::HttpClient;
use crate::ingest;
use crate::store::{Store, deflate};
use crate::url_norm::normalize;

pub const POLL_INTERVAL: Duration = Duration::from_secs(30 * 60);
/// Entries imported on the first fetch of a feed; older ones are only marked seen,
/// so subscribing to a blog with a full-archive feed does not import hundreds of posts.
pub const FIRST_IMPORT: usize = 20;
const MAX_BODY: usize = 10 * 1024 * 1024;
/// Entry text shorter than this (characters, tags stripped) is an excerpt, not the article.
const FULL_CONTENT_CHARS: usize = 500;

fn err(e: impl ToString) -> String {
    e.to_string()
}

#[derive(Debug, Serialize)]
pub struct FeedRow {
    pub id: i64,
    pub url: String,
    /// The feed's own title; `custom_title` (the user's name for it) is shown instead when set.
    pub title: Option<String>,
    pub custom_title: Option<String>,
    /// The user picked an icon (`icon`), shown in place of the site's favicon.
    pub has_icon: bool,
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

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Entry {
    pub url: String,
    /// Published (else updated) date, UTC ISO 8601: fills `articles.published_at` when the page has none.
    pub published: Option<String>,
    pub title: Option<String>,
    /// The entry's full HTML (RSS `content:encoded` or a long `description`, Atom `content` or a
    /// long `summary`); `None` when the feed only carries an excerpt.
    pub content: Option<String>,
}

/// A feed found on a page (autodiscovery), or the URL itself when it is one.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Candidate {
    pub url: String,
    pub title: Option<String>,
}

pub fn parse(body: &[u8], feed_url: &str) -> Result<Parsed, String> {
    let feed = feed_rs::parser::Builder::new().base_uri(Some(feed_url)).build().parse(body).map_err(|e| format!("not an RSS/Atom feed: {e}"))?;
    let alternate = |links: &[feed_rs::model::Link]| links.iter().find(|l| l.rel.as_deref().is_none_or(|r| r == "alternate")).map(|l| l.href.clone());
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
                let title = e.title.as_ref().map(|t| t.content.trim().to_string()).filter(|t| !t.is_empty());
                let summary = e.summary.as_ref().filter(|t| t.content_type.to_string().contains("html")).map(|t| t.content.clone());
                let content = e
                    .content
                    .as_ref()
                    .and_then(|c| c.body.clone())
                    .into_iter()
                    .chain(summary)
                    .map(|html| (text_chars(&html), html))
                    .max_by_key(|(n, _)| *n)
                    .filter(|(n, _)| *n >= FULL_CONTENT_CHARS)
                    .map(|(_, html)| html);
                Some(Entry { url, published, title, content })
            })
            .filter(|e| e.url.starts_with("https://") || e.url.starts_with("http://"))
            .collect(),
    })
}

fn text_chars(html: &str) -> usize {
    dom_query::Document::from(html).root().text().split_whitespace().map(|w| w.chars().count()).sum()
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
            "SELECT id, url, title, site_url, last_fetched_at, last_error, (SELECT count(*) FROM articles WHERE feed_id = feeds.id),
                    custom_title, icon IS NOT NULL
             FROM feeds ORDER BY coalesce(custom_title, title, url) COLLATE NOCASE",
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
            custom_title: r.get(7)?,
            has_icon: r.get(8)?,
        })
    })
    .map_err(err)?
    .collect::<Result<_, _>>()
    .map_err(err)
}

const MAX_NAME_CHARS: usize = 200;
/// Shown at 16 px: anything bigger is a mistake, not an icon.
const MAX_ICON_BYTES: usize = 1024 * 1024;

fn changed(rows: rusqlite::Result<usize>) -> Result<(), String> {
    match rows.map_err(err)? {
        0 => Err("feed no longer exists".into()),
        _ => Ok(()),
    }
}

/// The user's name for a feed; `None` or blank goes back to the feed's own title.
pub fn rename(store: &Store, id: i64, name: Option<&str>) -> Result<(), String> {
    let name = name.map(str::trim).filter(|n| !n.is_empty());
    if name.is_some_and(|n| n.chars().count() > MAX_NAME_CHARS) {
        return Err(format!("名前は {MAX_NAME_CHARS} 文字までです"));
    }
    changed(store.conn().execute("UPDATE feeds SET custom_title = ?2 WHERE id = ?1", params![id, name]))
}

/// The user's icon for a feed, typed by its content (PNG, JPEG, GIF, WebP, AVIF, ICO or SVG);
/// `None` goes back to the site's favicon. SVG is kept as is: the UI shows it only through
/// `<img>` from a `data:` URL, where its scripts never run.
pub fn set_icon(store: &Store, id: i64, bytes: Option<&[u8]>) -> Result<(), String> {
    let mime = match bytes {
        None => None,
        Some(b) if b.len() > MAX_ICON_BYTES => return Err("アイコンの画像は 1 MB までです".into()),
        Some(b) => {
            Some(crate::images::sniff(b).or_else(|| is_svg(b).then_some("image/svg+xml")).ok_or("PNG・JPEG・GIF・WebP・ICO・SVG の画像を選んでください")?)
        }
    };
    changed(store.conn().execute("UPDATE feeds SET icon_mime = ?2, icon = ?3 WHERE id = ?1", params![id, mime, bytes]))
}

fn is_svg(b: &[u8]) -> bool {
    std::str::from_utf8(b).is_ok_and(|s| s[..s.floor_char_boundary(4096)].to_ascii_lowercase().contains("<svg"))
}

/// The user's icon for a feed as a `data:` URL; `None` when it has none.
pub fn icon(store: &Store, id: i64) -> Result<Option<String>, String> {
    let row: Option<(Option<String>, Option<Vec<u8>>)> =
        store.conn().query_row("SELECT icon_mime, icon FROM feeds WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(err)?;
    Ok(row.and_then(|(mime, bytes)| Some(format!("data:{};base64,{}", mime?, crate::images::base64(&bytes?)))))
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

/// Network-free half of a refresh: queues entries this feed has not listed before, and stores
/// every entry's title and text. Articles that failed before their entry's text was known are
/// fetched again, so they fall back to it (once: only when the text first appears).
pub fn import(store: &Store, feed_id: i64, entries: &[Entry]) -> Result<usize, String> {
    let first: bool = !store.conn().query_row("SELECT EXISTS (SELECT 1 FROM feed_items WHERE feed_id = ?1)", [feed_id], |r| r.get(0)).map_err(err)?;
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
    let mut retry: Vec<i64> = Vec::new();
    {
        let mut put = c
            .prepare(
                "INSERT INTO feed_items (feed_id, normalized_url, published_at, title, content) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT DO UPDATE SET title = coalesce(excluded.title, title), content = coalesce(excluded.content, content)",
            )
            .map_err(err)?;
        let mut failed = c
            // Failed without having read the feed text (an ingest that ran before this entry's content
            // was stored): reading it again now converges, since the fallback then has content.
            .prepare(
                "SELECT id FROM articles WHERE feed_id = ?1 AND normalized_url = ?2 AND (fetch_status = 'failed' OR extraction_status = 'failed')
                   AND (SELECT content_type FROM snapshots WHERE article_id = articles.id ORDER BY id DESC LIMIT 1) IS NOT ?3",
            )
            .map_err(err)?;
        let mut done = std::collections::HashSet::new();
        for e in entries {
            let Ok(norm) = normalize(&e.url) else { continue };
            let norm = norm.to_string();
            if !done.insert(norm.clone()) {
                continue;
            }
            put.execute(params![feed_id, norm, e.published, e.title, e.content.as_deref().map(deflate)]).map_err(err)?;
            if e.content.is_some() {
                retry.extend(failed.query_row(params![feed_id, norm, ingest::FEED_CONTENT_TYPE], |r| r.get::<_, i64>(0)).optional().map_err(err)?);
            }
        }
    }
    // Already extracted without a date; articles still queued get it in `save_fetched`.
    c.execute(
        "UPDATE articles SET published_at = (SELECT value ->> 'p' FROM json_each(?1) WHERE value ->> 'u' = articles.normalized_url)
         WHERE published_at IS NULL AND extraction_status = 'ok'
           AND normalized_url IN (SELECT value ->> 'u' FROM json_each(?1) WHERE value ->> 'p' IS NOT NULL)",
        [&items],
    )
    .map_err(err)?;
    drop(c);
    for id in &retry {
        store.enqueue_job(ingest::JOB_TYPE, *id, "{}", &format!("{}:{id}", ingest::JOB_TYPE)).map_err(err)?;
    }
    Ok(summary.queued + retry.len())
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
        Entry { url: url.to_string(), ..Default::default() }
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
            html: format!(
                "<html><head><title>T</title>{meta}</head><body><article><p>Snapshot isolation permits write skew, which serializable snapshot isolation prevents at commit time. This sentence pads the paragraph so readability keeps it.</p></article></body></html>"
            ),
        };
        // Saved by hand before the feed listed it: filled at import.
        assert_eq!(ingest::enqueue_urls(&s, &["https://blog.dev/early".to_string()]).unwrap().queued, 1);
        let early_id = s.list_articles(&ArticleFilter::All).unwrap()[0].id;
        ingest::store_fetched(&s, early_id, &page("https://blog.dev/early", "")).unwrap();

        let (feed, _) = add(&s, "https://blog.dev/feed").unwrap();
        let dated = |url: &str, d: &str| Entry { url: url.to_string(), published: Some(d.to_string()), ..Default::default() };
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

    /// Medium-style feed: full text in `content:encoded`, links tagged `?source=rss…`.
    fn blocked_feed(with_content: bool) -> String {
        let para = "<p>Snapshot isolation prevents dirty reads but still permits write skew, which is why serializable snapshot isolation exists at all. </p>";
        let full = if with_content { format!("<content:encoded><![CDATA[<h3>Why</h3>{}]]></content:encoded>", para.repeat(6)) } else { String::new() };
        format!(
            r#"<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Tech</title>
            <item><title><![CDATA[Evolving the ads event pipeline for live — Part II]]></title><link>https://blog.dev/full-1a2b?source=rss----abc---4</link>
              <pubDate>Tue, 01 Oct 2024 00:00:00 GMT</pubDate><description>Short teaser.</description>{full}</item>
            <item><title>Teaser only</title><link>https://blog.dev/teaser?source=rss----abc---4</link><description>Short teaser.</description></item>
            </channel></rss>"#
        )
    }

    #[test]
    fn keeps_entry_titles_and_only_full_content() {
        let p = parse(blocked_feed(true).as_bytes(), "https://blog.dev/feed").unwrap();
        assert_eq!(p.entries[0].title.as_deref(), Some("Evolving the ads event pipeline for live — Part II"));
        assert!(p.entries[0].content.as_deref().unwrap().contains("<h3>Why</h3>"), "content:encoded, not the description");
        assert_eq!((p.entries[1].title.as_deref(), p.entries[1].content.as_deref()), (Some("Teaser only"), None), "an excerpt is not content");
    }

    #[test]
    fn refused_pages_fall_back_to_the_feed_text_or_a_render() {
        use crate::render;
        let s = Store::open_in_memory().unwrap();
        let (feed, _) = add(&s, "https://blog.dev/feed").unwrap();
        let entries = parse(blocked_feed(true).as_bytes(), "https://blog.dev/feed").unwrap().entries;
        assert_eq!(import(&s, feed, &entries).unwrap(), 2);
        let rows = s.list_articles(&ArticleFilter::All).unwrap();
        let row = |t: &str| rows.iter().find(|a| a.title.as_deref() == Some(t)).unwrap_or_else(|| panic!("{t}: {rows:?}")).id;
        let (full, teaser) = (row("Evolving the ads event pipeline for live — Part II"), row("Teaser only"));
        assert_eq!(s.article_url(full).unwrap().as_deref(), Some("https://blog.dev/full-1a2b?source=rss----abc---4"), "the original URL is kept");

        let refused = || Err("HTTP 403 Forbidden".to_string());
        ingest::store_fetch_result(&s, full, refused()).unwrap();
        let a = s.get_article(full, "ja").unwrap().unwrap();
        assert_eq!((a.article.fetch_status.as_str(), a.article.extraction_status.as_str(), a.article.from_feed), ("ok", "ok", true));
        assert_eq!(
            (a.article.title.as_deref(), a.article.last_error.as_deref()),
            (Some("Evolving the ads event pipeline for live — Part II"), Some("HTTP 403 Forbidden")),
            "the entry's title, not Readability's cut"
        );
        assert_eq!(a.article.published_at.as_deref(), Some("2024-10-01T00:00:00Z"));
        assert!(a.blocks.len() > 1 && !a.article.thin, "{:?}", a.blocks);
        assert!(!render::enqueue_if_auto(&s, full).unwrap(), "readable: no render");
        assert!(s.upsert_pending("https://blog.dev/full-1a2b", "https://blog.dev/full-1a2b", "blog.dev").unwrap().1, "saving again retries the page");

        ingest::store_fetch_result(&s, teaser, refused()).unwrap();
        let t = s.article_row(teaser).unwrap().unwrap();
        assert_eq!((t.fetch_status.as_str(), t.title.as_deref()), ("failed", Some("Teaser only")), "failed, but titled from the feed");
        assert!(render::enqueue_if_auto(&s, teaser).unwrap(), "no feed text: try a real browser");
        assert_eq!(s.claim_next_job(render::JOBS).unwrap().unwrap().article_id, Some(teaser));

        // A page that is gone is not worth rendering.
        ingest::store_fetch_result(&s, teaser, Err("HTTP 404 Not Found".into())).unwrap();
        assert!(!render::enqueue_if_auto(&s, teaser).unwrap());

        // Polling again changes nothing.
        let items = || s.conn().query_row("SELECT count(*) FROM feed_items", [], |r| r.get::<_, i64>(0)).unwrap();
        assert_eq!(import(&s, feed, &entries).unwrap(), 0);
        assert_eq!((s.list_articles(&ArticleFilter::All).unwrap().len(), items()), (2, 2));
    }

    #[test]
    fn articles_that_failed_before_the_feed_text_was_kept_recover_once() {
        let s = Store::open_in_memory().unwrap();
        let (feed, _) = add(&s, "https://blog.dev/feed").unwrap();
        let old = parse(blocked_feed(false).as_bytes(), "https://blog.dev/feed").unwrap().entries;
        import(&s, feed, &old).unwrap();
        while let Some(j) = s.claim_next_job(&[ingest::JOB_TYPE]).unwrap() {
            ingest::store_fetch_result(&s, j.article_id.unwrap(), Err("HTTP 403 Forbidden".into())).unwrap();
            s.finish_job(j.id, None).unwrap();
        }
        let failed = s
            .list_articles(&ArticleFilter::All)
            .unwrap()
            .into_iter()
            .find(|a| a.title.as_deref() == Some("Evolving the ads event pipeline for live — Part II"))
            .unwrap();
        assert_eq!(failed.fetch_status, "failed");

        let new = parse(blocked_feed(true).as_bytes(), "https://blog.dev/feed").unwrap().entries;
        assert_eq!(import(&s, feed, &new).unwrap(), 1, "the failed article whose text just appeared is fetched again");
        let job = s.claim_next_job(&[ingest::JOB_TYPE]).unwrap().unwrap();
        assert_eq!(job.article_id, Some(failed.id));
        ingest::store_fetch_result(&s, failed.id, Err("HTTP 403 Forbidden".into())).unwrap();
        s.finish_job(job.id, None).unwrap();
        assert!(s.article_row(failed.id).unwrap().unwrap().from_feed);
        assert_eq!(import(&s, feed, &new).unwrap(), 0, "once");
        assert!(s.claim_next_job(&[ingest::JOB_TYPE]).unwrap().is_none());
    }

    #[test]
    fn an_article_that_failed_while_its_feed_text_was_being_stored_is_retried() {
        let s = Store::open_in_memory().unwrap();
        let (feed, _) = add(&s, "https://blog.dev/feed").unwrap();
        import(&s, feed, &parse(blocked_feed(false).as_bytes(), "https://blog.dev/feed").unwrap().entries).unwrap();
        while let Some(j) = s.claim_next_job(&[ingest::JOB_TYPE]).unwrap() {
            ingest::store_fetch_result(&s, j.article_id.unwrap(), Err("HTTP 403 Forbidden".into())).unwrap();
            s.finish_job(j.id, None).unwrap();
        }
        let new = parse(blocked_feed(true).as_bytes(), "https://blog.dev/feed").unwrap().entries;
        assert_eq!(import(&s, feed, &new).unwrap(), 1);
        // The retry is lost (it ran before the content was visible), so the article is still failed from the page.
        let job = s.claim_next_job(&[ingest::JOB_TYPE]).unwrap().unwrap();
        s.finish_job(job.id, None).unwrap();
        assert_eq!(import(&s, feed, &new).unwrap(), 1, "the next poll retries it");
    }

    #[test]
    fn names_and_icons_override_the_feeds_own() {
        let s = Store::open_in_memory().unwrap();
        let (id, _) = add(&s, "https://blog.dev/feed").unwrap();
        import(&s, id, &[entry("https://blog.dev/p")]).unwrap();
        mark_fetched(&s, id, Some(&Parsed { title: Some("Blog".into()), ..Default::default() }), None, None).unwrap();
        let shown = || (list(&s).unwrap()[0].custom_title.clone(), s.list_articles(&ArticleFilter::All).unwrap()[0].feed_title.clone());

        rename(&s, id, Some("  My blog ")).unwrap();
        assert_eq!(shown(), (Some("My blog".into()), Some("My blog".into())));
        assert_eq!(list(&s).unwrap()[0].title.as_deref(), Some("Blog"), "the feed's own title is kept");
        assert!(rename(&s, id, Some(&"x".repeat(MAX_NAME_CHARS + 1))).is_err());
        rename(&s, id, Some(" ")).unwrap();
        assert_eq!(shown(), (None, Some("Blog".into())), "blank resets");
        assert!(rename(&s, 999, Some("x")).is_err());

        const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
        assert_eq!(icon(&s, id).unwrap(), None);
        set_icon(&s, id, Some(PNG)).unwrap();
        assert!(list(&s).unwrap()[0].has_icon);
        assert!(icon(&s, id).unwrap().unwrap().starts_with("data:image/png;base64,"));
        let svg = br#"<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>"#;
        set_icon(&s, id, Some(svg)).unwrap();
        assert!(icon(&s, id).unwrap().unwrap().starts_with("data:image/svg+xml;base64,"), "stored, shown only as an image");
        assert!(set_icon(&s, id, Some(b"<html>not an image</html>")).is_err());
        assert!(set_icon(&s, id, Some(&[PNG, &vec![0; MAX_ICON_BYTES]].concat())).is_err());
        set_icon(&s, id, None).unwrap();
        assert_eq!((icon(&s, id).unwrap(), list(&s).unwrap()[0].has_icon), (None, false));
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
