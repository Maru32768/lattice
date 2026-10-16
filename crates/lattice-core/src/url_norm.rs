use url::Url;

const TRACKING_PREFIXES: &[&str] = &["utm_", "mc_", "_hs"];
const TRACKING_KEYS: &[&str] = &["fbclid", "gclid", "dclid", "msclkid", "yclid", "igshid", "ref_src", "spm"];

/// Normalized form used as the dedup key: http(s) only, no fragment, no tracking params.
/// Host lowercasing and default-port removal come from `url` itself.
pub fn normalize(input: &str) -> Result<Url, String> {
    let mut u = Url::parse(input.trim()).map_err(|e| format!("invalid URL: {e}"))?;
    if !matches!(u.scheme(), "http" | "https") {
        return Err(format!("unsupported scheme: {}", u.scheme()));
    }
    u.set_fragment(None);
    let kept: Vec<(String, String)> = u
        .query_pairs()
        .filter(|(k, _)| {
            let k = k.to_ascii_lowercase();
            !TRACKING_KEYS.contains(&k.as_str()) && !TRACKING_PREFIXES.iter().any(|p| k.starts_with(p))
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
        assert!(normalize("javascript:alert(1)").is_err());
        assert!(normalize("not a url").is_err());
    }
}
