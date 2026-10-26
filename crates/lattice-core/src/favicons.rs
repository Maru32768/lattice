//! Site icons for the feed and article lists. Fetched in the backend only (the app webview
//! loads no remote images, §14) and stored per domain: a row holds the icon or why there is
//! none, and either is refetched when asked for after a week.

use rusqlite::{OptionalExtension, params};
use url::Url;

use crate::fetch::fetch;
use crate::images::{Fail, base64, download};
use crate::store::Store;

pub const JOB_TYPE: &str = "favicon";
/// Icons are tiny; this only bounds a hostile server.
const MAX_BYTES: usize = 1024 * 1024;
const REFETCH_AFTER: &str = "-7 days";

fn err(e: impl ToString) -> String {
    e.to_string()
}

/// The site root of `domain`, which must be a bare host as stored in `articles.domain`.
fn root(domain: &str) -> Result<Url, String> {
    Url::parse(&format!("https://{domain}/"))
        .ok()
        .filter(|u| u.host_str() == Some(domain) && u.port().is_none() && u.path() == "/")
        .ok_or_else(|| format!("invalid domain: {domain}"))
}

/// The stored icon as a `data:` URL; `None` while not fetched yet or when the site has none.
/// Queues a fetch when the domain has no row or its row is over a week old, and says whether it did.
pub fn get(store: &Store, domain: &str) -> Result<(Option<String>, bool), String> {
    root(domain)?;
    let row: Option<(Option<String>, Option<Vec<u8>>, bool)> = store
        .conn()
        .query_row(
            "SELECT mime, bytes, fetched_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?2) FROM favicons WHERE domain = ?1",
            params![domain, REFETCH_AFTER],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(err)?;
    let queued = if row.as_ref().is_none_or(|r| r.2) {
        enqueue(store, domain)?
    } else {
        false
    };
    let icon = row.and_then(|(mime, bytes, _)| Some(format!("data:{};base64,{}", mime?, base64(&bytes?))));
    Ok((icon, queued))
}

/// One job per domain (no article). A finished one (done or given up) is reset; a queued or
/// running one is left alone.
fn enqueue(store: &Store, domain: &str) -> Result<bool, String> {
    let n = store
        .conn()
        .execute(
            "INSERT INTO processing_jobs (type, params, dedup_key) VALUES (?1, json_object('domain', ?2), ?1 || ':' || ?2)
             ON CONFLICT(dedup_key) DO UPDATE SET status = 'pending', attempt_count = 0, last_error = NULL, next_run_at = NULL
             WHERE status IN ('succeeded', 'failed')",
            params![JOB_TYPE, domain],
        )
        .map_err(err)?;
    Ok(n > 0)
}

/// `<link rel~=icon href>` targets of a page, in document order: http(s) only, no SVG (it can
/// carry script, as for article images).
fn icon_links(html: &str, base: &str) -> Vec<String> {
    let Ok(base) = Url::parse(base) else {
        return Vec::new();
    };
    let doc = dom_query::Document::from(html);
    let mut out: Vec<String> = Vec::new();
    for link in doc.select("link[rel][href]").iter() {
        let lower = |n: &str| link.attr(n).map(|v| v.to_ascii_lowercase()).unwrap_or_default();
        if !lower("rel").split_ascii_whitespace().any(|r| r == "icon") || lower("type").contains("svg") {
            continue;
        }
        let Some(url) = link.attr("href").and_then(|h| base.join(h.trim()).ok()) else {
            continue;
        };
        let svg = url.path().to_ascii_lowercase().ends_with(".svg");
        if matches!(url.scheme(), "http" | "https") && !svg && !out.contains(&url.to_string()) {
            out.push(url.to_string());
        }
    }
    out
}

/// The newest stored page of the site: (final URL, HTML).
fn snapshot(store: &Store, domain: &str) -> Result<Option<(String, String)>, String> {
    let id: Option<i64> = store
        .conn()
        .query_row("SELECT id FROM articles WHERE domain = ?1 AND fetch_status = 'ok' ORDER BY id DESC LIMIT 1", [domain], |r| r.get(0))
        .optional()
        .map_err(err)?;
    let Some(id) = id else {
        return Ok(None);
    };
    Ok(store.latest_snapshot(id).map_err(err)?.map(|s| {
        let html = s.html();
        (s.final_url, html)
    }))
}

/// Background job: the icon links of a stored page of the site (else of its root page), then
/// `/favicon.ico`; stores the first that downloads, or why none did. Downloads go through the
/// article-image checks (destination policy, size cap, raster formats by magic number). Transient
/// failures (timeouts, 5xx, 429) with nothing stored fail the job, so it retries with backoff.
pub async fn run(store: &Store, client: &crate::fetch::HttpClient, domain: &str) -> Result<(), String> {
    let root = root(domain)?;
    let mut candidates = snapshot(store, domain)?.map(|(base, html)| icon_links(&html, &base)).unwrap_or_default();
    if candidates.is_empty()
        && let Ok(page) = fetch(client, root.as_str()).await
    {
        candidates = icon_links(&page.html, &page.final_url);
    }
    let ico = root.join("/favicon.ico").expect("static path").to_string();
    if !candidates.contains(&ico) {
        candidates.push(ico);
    }
    let (mut permanent, mut transient) = (None, None);
    for src in candidates {
        match download(client, &src, root.as_str(), MAX_BYTES).await {
            Ok((mime, bytes)) => return save(store, domain, Some((mime, &bytes)), None),
            Err(Fail::Permanent(e)) => permanent = Some(format!("{src}: {e}")),
            Err(Fail::Transient(e)) => transient = Some(format!("{src}: {e}")),
        }
    }
    match transient {
        Some(e) => Err(e),
        None => save(store, domain, None, permanent.as_deref()),
    }
}

fn save(store: &Store, domain: &str, icon: Option<(&str, &[u8])>, error: Option<&str>) -> Result<(), String> {
    store
        .conn()
        .execute(
            "INSERT INTO favicons (domain, mime, bytes, error) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(domain) DO UPDATE SET mime = ?2, bytes = ?3, error = ?4, fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
            params![domain, icon.map(|i| i.0), icon.map(|i| i.1), error],
        )
        .map(drop)
        .map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    #[test]
    fn finds_icon_links() {
        let html = r#"<head>
            <link rel="apple-touch-icon" href="/touch.png">
            <link rel="ICON" type="image/svg+xml" href="/icon.svg">
            <link rel="shortcut icon" href="/static/fav.PNG?v=2">
            <link rel="icon" href="logo.svg">
            <link rel="icon" href="javascript:alert(1)">
            <link rel="icon" sizes="32x32" href="https://cdn.example.net/i32.png">
            <link rel="stylesheet" href="/a.css"></head>"#;
        assert_eq!(icon_links(html, "https://blog.example.com/posts/1"), ["https://blog.example.com/static/fav.PNG?v=2", "https://cdn.example.net/i32.png"]);
    }

    #[test]
    fn rejects_anything_but_a_bare_host() {
        assert!(root("blog.example.com").is_ok() && root("127.0.0.1").is_ok());
        for bad in ["", "Example.com", "example.com:8080", "example.com/x", "a b", "user@example.com"] {
            assert!(root(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn queues_once_serves_and_refetches_weekly() {
        let s = Store::open_in_memory().unwrap();
        assert_eq!(get(&s, "blog.example.com").unwrap(), (None, true));
        assert_eq!(get(&s, "blog.example.com").unwrap(), (None, false), "already queued");
        let job = s.claim_next_job(&[JOB_TYPE]).unwrap().unwrap();
        assert_eq!((job.article_id, job.params.as_deref()), (None, Some(r#"{"domain":"blog.example.com"}"#)));

        save(&s, "blog.example.com", Some(("image/png", PNG)), None).unwrap();
        s.finish_job(job.id, None).unwrap();
        let png = format!("data:image/png;base64,{}", base64(PNG));
        assert_eq!(get(&s, "blog.example.com").unwrap(), (Some(png.clone()), false));

        s.exec_for_test("UPDATE favicons SET fetched_at = '2000-01-01T00:00:00.000Z'");
        assert_eq!(get(&s, "blog.example.com").unwrap(), (Some(png), true), "stale: served and refetched");

        save(&s, "none.example.com", None, Some("HTTP 404")).unwrap();
        assert_eq!(get(&s, "none.example.com").unwrap(), (None, false), "a failure is cached too");
        assert!(get(&s, "bad domain").is_err());
    }

    #[tokio::test]
    async fn private_hosts_are_refused_and_the_failure_stored() {
        let s = Store::open_in_memory().unwrap();
        run(&s, &crate::fetch::client(), "127.0.0.1").await.unwrap();
        let error: Option<String> = s.conn().query_row("SELECT error FROM favicons WHERE domain = '127.0.0.1'", [], |r| r.get(0)).unwrap();
        assert!(error.unwrap().contains("network.blocked"), "no request leaves for a private address");
    }
}
