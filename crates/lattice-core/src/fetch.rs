use std::time::Duration;

pub use reqwest::Client as HttpClient;

/// Web pages are untrusted: cap the body so a hostile server can't exhaust memory.
pub const MAX_BODY: usize = 20 * 1024 * 1024;

pub struct Fetched {
    pub final_url: String,
    pub status: u16,
    pub content_type: Option<String>,
    pub html: String,
}

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(concat!("Lattice/", env!("CARGO_PKG_VERSION"), " (+local reader)"))
        .timeout(Duration::from_secs(30))
        .build()
        .expect("static client config")
}

pub async fn fetch(client: &reqwest::Client, url: &str) -> Result<Fetched, String> {
    let mut resp = client.get(url).send().await.map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    if let Some(ct) = &content_type {
        if !ct.contains("html") {
            return Err(format!("unsupported content type: {ct}"));
        }
    }
    let final_url = resp.url().to_string();
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("read failed: {e}"))? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_BODY {
            return Err(format!("body exceeds {MAX_BODY} bytes"));
        }
    }
    let html = decode_html(content_type.as_deref(), &body);
    Ok(Fetched { final_url, status: status.as_u16(), content_type, html })
}

/// Charset precedence follows browsers: BOM (handled by `decode`), Content-Type, then
/// `<meta charset>` / `http-equiv` within the first 1024 bytes, else UTF-8.
fn decode_html(content_type: Option<&str>, body: &[u8]) -> String {
    let head = String::from_utf8_lossy(&body[..body.len().min(1024)]).to_ascii_lowercase();
    let encoding = content_type
        .map(str::to_ascii_lowercase)
        .and_then(|ct| charset_label(&ct))
        .or_else(|| charset_label(&head))
        .and_then(|l| encoding_rs::Encoding::for_label(l.as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);
    encoding.decode(body).0.into_owned()
}

fn charset_label(s: &str) -> Option<String> {
    let rest = &s[s.find("charset=")? + "charset=".len()..];
    let rest = rest.trim_start_matches(['"', '\'', ' ']);
    let label: String = rest.chars().take_while(|c| !matches!(c, '"' | '\'' | ';' | ' ' | '>' | '/')).collect();
    (!label.is_empty()).then_some(label)
}

#[cfg(test)]
mod tests {
    use super::decode_html;

    #[test]
    fn detects_charset() {
        let sjis = b"<html><head><meta charset=\"Shift_JIS\"></head><body>\x93\xfa\x96\x7b\x8c\xea</body></html>";
        assert!(decode_html(None, sjis).contains("日本語"));
        let equiv = b"<meta http-equiv=\"Content-Type\" content=\"text/html; charset=EUC-JP\">\xc6\xfc\xcb\xdc";
        assert!(decode_html(Some("text/html"), equiv).contains("日本"));
        // Header wins over meta; unknown labels fall back to UTF-8.
        assert!(decode_html(Some("text/html; charset=utf-8"), "<meta charset=shift_jis>日本".as_bytes()).contains("日本"));
        assert!(decode_html(Some("text/html; charset=bogus"), "é".as_bytes()).contains('é'));
    }
}
