use std::time::Duration;

pub use reqwest::Client as HttpClient;

/// Web pages are untrusted: cap the body so a hostile server can't exhaust memory.
const MAX_BODY: usize = 20 * 1024 * 1024;

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
    // shortcut: charset only from Content-Type (else UTF-8); sniff <meta charset> when non-UTF-8 sites show mojibake.
    let encoding = content_type
        .as_deref()
        .and_then(|ct| ct.split("charset=").nth(1))
        .and_then(|cs| encoding_rs::Encoding::for_label(cs.trim_matches(['"', ' ', ';']).as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);
    let (html, _, _) = encoding.decode(&body);
    Ok(Fetched { final_url, status: status.as_u16(), content_type, html: html.into_owned() })
}
