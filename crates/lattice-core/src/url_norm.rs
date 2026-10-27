use url::Url;

const TRACKING_PREFIXES: &[&str] = &["utm_", "mc_", "_hs"];
const TRACKING_KEYS: &[&str] = &["fbclid", "gclid", "dclid", "msclkid", "yclid", "igshid", "ref_src", "spm"];

/// Normalized form used as the dedup key: http(s) only, no fragment, no tracking params, and
/// http folded into https (a feed linking `http://` must match the page the browser lands on).
/// Only a key: pages are fetched from their original URL. Host lowercasing and default-port
/// removal come from `url` itself.
pub fn normalize(input: &str) -> Result<Url, String> {
    let mut u = Url::parse(input.trim()).map_err(|e| format!("invalid URL: {e}"))?;
    if !matches!(u.scheme(), "http" | "https") {
        return Err(format!("unsupported scheme: {}", u.scheme()));
    }
    // A URL on its own port (a local server) keeps http: https://host:8080 would be another site.
    if u.scheme() == "http" && u.port().is_none() {
        let _ = u.set_scheme("https");
    }
    u.set_fragment(None);
    let kept: Vec<(String, String)> = u
        .query_pairs()
        .filter(|(k, v)| {
            let k = k.to_ascii_lowercase();
            // Medium tags every feed link `?source=rss----<id>---4`; other `source` values may matter.
            let rss_source = k == "source" && v.starts_with("rss");
            !TRACKING_KEYS.contains(&k.as_str()) && !TRACKING_PREFIXES.iter().any(|p| k.starts_with(p)) && !rss_source
        })
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    if kept.is_empty() {
        u.set_query(None);
    } else {
        u.query_pairs_mut().clear().extend_pairs(kept);
    }
    Ok(u)
}

#[cfg(test)]
mod tests {
    use super::normalize;

    #[test]
    fn strips_tracking_and_fragment() {
        let n = |s| normalize(s).unwrap().to_string();
        assert_eq!(n("HTTPS://Example.COM:443/a?utm_source=x&id=3&fbclid=y#sec"), "https://example.com/a?id=3");
        assert_eq!(n("https://example.com/a?utm_medium=rss"), "https://example.com/a");
        assert_eq!(n("https://netflixtechblog.com/a-post-0123abcd?source=rss----2615bd06b42e---4"), "https://netflixtechblog.com/a-post-0123abcd");
        assert_eq!(n("https://example.com/a?source=github&id=1"), "https://example.com/a?source=github&id=1");
        assert_eq!(n("http://brooker.co.za/blog/a.html"), "https://brooker.co.za/blog/a.html");
        assert_eq!(n("http://localhost:8080/a"), "http://localhost:8080/a");
        assert!(normalize("javascript:alert(1)").is_err());
        assert!(normalize("not a url").is_err());
    }
}
