//! Article images (§6, §26-10): downloaded after extraction and kept in SQLite, so they survive
//! link rot and go into the single-file backup (§17). Bytes are deduplicated by content hash;
//! `article_images` maps each image URL an article references to its bytes, and a trigger drops
//! bytes no mapping uses any more. The Reader gets them as `data:` URLs: the app webview never
//! loads a remote URL. Raster formats only: SVG can carry script, so it stays a link.

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::fetch::{check_public, request_error};
use crate::store::Store;

pub const JOB_TYPE: &str = "images";
/// "off" stops downloading (stored images stay); absent means on.
pub const SAVE_SETTING: &str = "save_images";
pub const MAX_MB_SETTING: &str = "image_max_mb";
pub const DEFAULT_MAX_MB: u32 = 5;
pub const MAX_MB_LIMIT: u32 = 20;
/// All stored images of one article together: a gallery page must not add hundreds of MB.
pub const ARTICLE_CAP: usize = 30 * 1024 * 1024;
const MB: usize = 1024 * 1024;

fn err(e: impl ToString) -> String {
    e.to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ImageSettings {
    pub save: bool,
    /// Per-image size cap in MB.
    pub max_mb: u32,
}

pub fn settings(store: &Store) -> Result<ImageSettings, String> {
    let save = store.setting(SAVE_SETTING).map_err(err)?.as_deref() != Some("off");
    let max_mb = store.setting(MAX_MB_SETTING).map_err(err)?.and_then(|v| v.parse().ok()).unwrap_or(DEFAULT_MAX_MB);
    Ok(ImageSettings { save, max_mb })
}

pub fn set_settings(store: &Store, s: ImageSettings) -> Result<(), String> {
    if !(1..=MAX_MB_LIMIT).contains(&s.max_mb) {
        return Err(format!("1 枚あたりの上限は 1〜{MAX_MB_LIMIT} MB で指定してください"));
    }
    store.set_setting(SAVE_SETTING, (!s.save).then_some("off")).map_err(err)?;
    store.set_setting(MAX_MB_SETTING, Some(&s.max_mb.to_string())).map_err(err)
}

/// After every extraction: downloads new image URLs and drops mappings of removed ones.
/// Returns whether a job was queued.
pub fn enqueue(store: &Store, article_id: i64) -> Result<bool, String> {
    let wanted: bool = store
        .conn()
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM blocks WHERE article_id = ?1 AND kind = 'image')
                 OR EXISTS (SELECT 1 FROM article_images WHERE article_id = ?1)",
            [article_id],
            |r| r.get(0),
        )
        .map_err(err)?;
    if wanted {
        store.enqueue_job(JOB_TYPE, article_id, "{}", &format!("{JOB_TYPE}:{article_id}")).map_err(err)?;
    }
    Ok(wanted)
}

/// Startup and when saving is switched on: articles with image URLs never tried (saved before
/// this feature or while it was off). Returns the number of jobs queued or reset.
pub fn enqueue_missing(store: &Store) -> Result<usize, String> {
    if !settings(store)?.save {
        return Ok(0);
    }
    store
        .conn()
        .execute(
            "INSERT INTO processing_jobs (type, article_id, params, dedup_key)
             SELECT ?1, a.id, '{}', ?1 || ':' || a.id FROM articles a
             WHERE a.extraction_status = 'ok' AND EXISTS (
                 SELECT 1 FROM blocks b WHERE b.article_id = a.id AND b.kind = 'image' AND NOT EXISTS (
                     SELECT 1 FROM article_images ai WHERE ai.article_id = a.id AND ai.src = json_extract(b.attrs, '$.src')))
             ON CONFLICT(dedup_key) DO UPDATE SET status = 'pending', attempt_count = 0, last_error = NULL, next_run_at = NULL
             WHERE status = 'succeeded'",
            [JOB_TYPE],
        )
        .map_err(err)
}

/// Why an image was not stored. Transient failures (timeouts, 5xx, 429) leave no record, so
/// the job's retry with backoff tries them again; permanent ones are recorded and not retried.
#[derive(Debug, PartialEq)]
enum Fail {
    Permanent(String),
    Transient(String),
}

pub async fn run(store: &Store, client: &reqwest::Client, article_id: i64) -> Result<(), String> {
    let (page, pending, mut used) = {
        let c = store.conn();
        c.execute(
            "DELETE FROM article_images WHERE article_id = ?1 AND src NOT IN (
                 SELECT json_extract(attrs, '$.src') FROM blocks
                 WHERE article_id = ?1 AND kind = 'image' AND json_extract(attrs, '$.src') IS NOT NULL)",
            [article_id],
        )
        .map_err(err)?;
        let page: Option<String> =
            c.query_row("SELECT original_url FROM articles WHERE id = ?1", [article_id], |r| r.get(0)).optional().map_err(err)?;
        let mut st = c
            .prepare(
                "SELECT json_extract(b.attrs, '$.src') AS s FROM blocks b
                 WHERE b.article_id = ?1 AND b.kind = 'image' AND s IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM article_images ai WHERE ai.article_id = ?1 AND ai.src = json_extract(b.attrs, '$.src'))
                 GROUP BY s ORDER BY min(b.ordinal)",
            )
            .map_err(err)?;
        let pending: Vec<String> = st.query_map([article_id], |r| r.get(0)).map_err(err)?.collect::<Result<_, _>>().map_err(err)?;
        let used: i64 = c
            .query_row(
                "SELECT coalesce(sum(length(i.bytes)), 0) FROM article_images ai JOIN images i ON i.hash = ai.hash WHERE ai.article_id = ?1",
                [article_id],
                |r| r.get(0),
            )
            .map_err(err)?;
        (page, pending, used as usize)
    };
    let Some(page) = page else { return Ok(()) };
    let s = settings(store)?;
    if !s.save || pending.is_empty() {
        return Ok(());
    }
    let mut transient = None;
    for src in pending {
        let over = "記事あたりの画像の上限（30 MB）を超えました";
        if used >= ARTICLE_CAP {
            record(store, article_id, &src, None, Some(over))?;
            continue;
        }
        match download(client, &src, &page, s.max_mb as usize * MB).await {
            Ok((_, bytes)) if used + bytes.len() > ARTICLE_CAP => record(store, article_id, &src, None, Some(over))?,
            Ok((mime, bytes)) => {
                used += bytes.len();
                save(store, article_id, &src, mime, &bytes)?;
            }
            Err(Fail::Permanent(e)) => record(store, article_id, &src, None, Some(&e))?,
            Err(Fail::Transient(e)) => {
                log::info!("image {src}: {e}");
                transient = Some(e);
            }
        }
    }
    match transient {
        Some(e) => Err(format!("一部の画像を取得できませんでした（後で再試行します）: {e}")),
        None => Ok(()),
    }
}

/// Stores `bytes` once per content hash and maps `src` of the article to it.
pub(crate) fn save(store: &Store, article_id: i64, src: &str, mime: &str, bytes: &[u8]) -> Result<(), String> {
    let hash: String = Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect();
    {
        let c = store.conn();
        c.execute("INSERT INTO images (hash, mime, bytes) VALUES (?1, ?2, ?3) ON CONFLICT(hash) DO NOTHING", params![hash, mime, bytes])
            .map_err(err)?;
    }
    record(store, article_id, src, Some(&hash), None)
}

fn record(store: &Store, article_id: i64, src: &str, hash: Option<&str>, error: Option<&str>) -> Result<(), String> {
    store
        .conn()
        .execute(
            "INSERT INTO article_images (article_id, src, hash, error) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(article_id, src) DO NOTHING",
            params![article_id, src, hash, error],
        )
        .map_err(err)?;
    Ok(())
}

async fn download(client: &reqwest::Client, src: &str, referer: &str, cap: usize) -> Result<(&'static str, Vec<u8>), Fail> {
    if !(src.starts_with("https://") || src.starts_with("http://")) {
        return Err(Fail::Permanent("http(s) 以外の URL です".into()));
    }
    check_public(src).map_err(Fail::Permanent)?;
    // Many sites refuse hotlinked images without a Referer from their own pages.
    let sent = client.get(src).header(reqwest::header::REFERER, referer).send().await;
    let mut resp = sent.map_err(|e| if e.is_timeout() { Fail::Transient(request_error(e)) } else { Fail::Permanent(request_error(e)) })?;
    let status = resp.status();
    if status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(Fail::Transient(format!("HTTP {status}")));
    }
    if !status.is_success() {
        return Err(Fail::Permanent(format!("HTTP {status}")));
    }
    let ct = resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).map(str::to_string);
    check_response(ct.as_deref(), resp.content_length(), cap).map_err(Fail::Permanent)?;
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| Fail::Transient(format!("read failed: {e}")))? {
        body.extend_from_slice(&chunk);
        if body.len() > cap {
            return Err(Fail::Permanent(too_large(cap)));
        }
    }
    let mime = sniff(&body).ok_or_else(|| Fail::Permanent("対応していない画像形式です（PNG・JPEG・GIF・WebP・AVIF のみ保存します）".into()))?;
    Ok((mime, body))
}

fn too_large(cap: usize) -> String {
    format!("1 枚あたりの上限（{} MB）を超えています", cap / MB)
}

/// Header checks before reading the body. The stored type comes from `sniff`, never the header.
fn check_response(content_type: Option<&str>, content_length: Option<u64>, cap: usize) -> Result<(), String> {
    let ct = content_type.unwrap_or("").to_ascii_lowercase();
    let image = ct.starts_with("image/") || ct.is_empty() || ct.starts_with("application/octet-stream");
    if !image || ct.contains("svg") {
        return Err(format!("保存しない形式です: {ct}"));
    }
    if content_length.is_some_and(|n| n > cap as u64) {
        return Err(too_large(cap));
    }
    Ok(())
}

/// Raster formats by magic number. Anything else (SVG, HTML error pages) is not stored.
fn sniff(b: &[u8]) -> Option<&'static str> {
    match b {
        [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n', ..] => Some("image/png"),
        [0xff, 0xd8, 0xff, ..] => Some("image/jpeg"),
        [b'G', b'I', b'F', b'8', b'7' | b'9', b'a', ..] => Some("image/gif"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some("image/webp"),
        [_, _, _, _, b'f', b't', b'y', b'p', b'a', b'v', b'i', b'f' | b's', ..] => Some("image/avif"),
        _ => None,
    }
}

/// The stored image of an image block as a `data:` URL (the main webview's CSP allows
/// `data:` and nothing remote); `None` while not downloaded or when it was not stored.
pub fn data_url(store: &Store, block_id: i64) -> Result<Option<String>, String> {
    let row: Option<(String, Vec<u8>)> = store
        .conn()
        .query_row(
            "SELECT i.mime, i.bytes FROM blocks b
             JOIN article_images ai ON ai.article_id = b.article_id AND ai.src = json_extract(b.attrs, '$.src')
             JOIN images i ON i.hash = ai.hash
             WHERE b.id = ?1 AND b.kind = 'image'",
            [block_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(err)?;
    Ok(row.map(|(mime, bytes)| format!("data:{mime};base64,{}", base64(&bytes))))
}

fn base64(b: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(b.len().div_ceil(3) * 4);
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            s.push(if i <= c.len() { T[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fetch::Fetched;
    use crate::ir::{ArticleIr, Block, BlockAttrs, BlockKind};

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    #[test]
    fn filters_by_type_and_size() {
        assert_eq!(sniff(PNG), Some("image/png"));
        assert_eq!(sniff(b"\xff\xd8\xff\xe0"), Some("image/jpeg"));
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff(b"\0\0\0\x1cftypavif"), Some("image/avif"));
        assert_eq!(sniff(b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>"), None);
        assert_eq!(sniff(b"<!doctype html>"), None);
        assert!(check_response(Some("image/png"), Some(1000), MB).is_ok());
        assert!(check_response(None, None, MB).is_ok(), "type is then decided by sniffing");
        assert!(check_response(Some("application/octet-stream"), None, MB).is_ok());
        assert!(check_response(Some("image/svg+xml"), None, MB).is_err());
        assert!(check_response(Some("text/html; charset=utf-8"), None, MB).is_err());
        assert!(check_response(Some("image/jpeg"), Some(MB as u64 + 1), MB).unwrap_err().contains("上限"));
    }

    #[tokio::test]
    async fn refuses_other_schemes_and_private_hosts() {
        let c = crate::fetch::client();
        for src in ["ftp://example.com/a.png", "data:image/png;base64,AAAA", "http://127.0.0.1/a.png", "http://[::1]/a.png"] {
            assert!(matches!(download(&c, src, "https://example.com/", MB).await, Err(Fail::Permanent(_))), "{src}");
        }
    }

    #[test]
    fn encodes_base64() {
        let cases = [("", ""), ("f", "Zg=="), ("fo", "Zm8="), ("foo", "Zm9v"), ("foob", "Zm9vYg=="), ("fooba", "Zm9vYmE="), ("foobar", "Zm9vYmFy")];
        for (i, o) in cases {
            assert_eq!(base64(i.as_bytes()), o);
        }
        assert_eq!(base64(&[0xff, 0xfe]), "//4=");
    }

    fn article(s: &Store, url: &str, srcs: &[&str]) -> i64 {
        let (id, _) = s.upsert_pending(url, url, "example.com").unwrap();
        let mut blocks = vec![Block { kind: BlockKind::Paragraph, text: "body".into(), inlines: vec![], attrs: Default::default() }];
        blocks.extend(srcs.iter().map(|src| Block {
            kind: BlockKind::Image,
            text: String::new(),
            inlines: vec![],
            attrs: BlockAttrs { src: Some(src.to_string()), ..Default::default() },
        }));
        let f = Fetched { final_url: url.into(), status: 200, content_type: None, html: "<p>x</p>".into() };
        s.save_fetched(id, Some(&f), Ok(ArticleIr { meta: Default::default(), blocks }), None).unwrap();
        id
    }

    fn count(s: &Store, table: &str) -> i64 {
        s.conn().query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0)).unwrap()
    }

    fn image_block(s: &Store, id: i64) -> i64 {
        s.get_article(id, "ja").unwrap().unwrap().blocks.iter().find(|b| b.block.kind == BlockKind::Image).unwrap().id
    }

    #[tokio::test]
    async fn dedups_serves_and_collects_garbage() {
        let s = Store::open_in_memory().unwrap();
        let a = article(&s, "https://example.com/a", &["https://cdn.example.com/x.png", "https://cdn.example.com/y.svg"]);
        let b = article(&s, "https://example.com/b", &["https://other.example.com/copy.png"]);
        assert!(enqueue(&s, a).unwrap());
        save(&s, a, "https://cdn.example.com/x.png", "image/png", PNG).unwrap();
        record(&s, a, "https://cdn.example.com/y.svg", None, Some("保存しない形式です: image/svg+xml")).unwrap();
        save(&s, b, "https://other.example.com/copy.png", "image/png", PNG).unwrap();
        assert_eq!(count(&s, "images"), 1, "same bytes stored once");

        let url = data_url(&s, image_block(&s, a)).unwrap().unwrap();
        assert_eq!(url, format!("data:image/png;base64,{}", base64(PNG)));
        assert_eq!(data_url(&s, image_block(&s, b)).unwrap().as_deref(), Some(url.as_str()));
        let svg = s.get_article(a, "ja").unwrap().unwrap().blocks.last().unwrap().id;
        assert_eq!(data_url(&s, svg).unwrap(), None, "not stored: the Reader shows the link");
        let mut out = Vec::new();
        crate::export::export_to(&s, &mut out).unwrap();
        let hash: String = Sha256::digest(PNG).iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(String::from_utf8(out).unwrap().matches(&format!("\"image_hash\":\"{hash}\"")).count(), 2, "export lists hashes, not bytes");

        // Re-extraction drops the PNG from a; b still uses the bytes. Nothing is pending, so no network.
        article(&s, "https://example.com/a", &["https://cdn.example.com/y.svg"]);
        run(&s, &crate::fetch::client(), a).await.unwrap();
        assert_eq!((count(&s, "article_images"), count(&s, "images")), (2, 1));
        // Deleting b cascades to its mapping and the trigger removes the now unused bytes.
        s.exec_for_test(&format!("DELETE FROM articles WHERE id = {b}"));
        assert_eq!((count(&s, "article_images"), count(&s, "images")), (1, 0));
    }

    #[test]
    fn backfill_skips_tried_urls_and_respects_the_setting() {
        let s = Store::open_in_memory().unwrap();
        let a = article(&s, "https://example.com/a", &["https://cdn.example.com/x.png"]);
        article(&s, "https://example.com/b", &[]);
        assert_eq!(enqueue_missing(&s).unwrap(), 1);
        s.finish_job(s.claim_next_job(&[JOB_TYPE]).unwrap().unwrap().id, None).unwrap();
        record(&s, a, "https://cdn.example.com/x.png", None, Some("HTTP 404")).unwrap();
        assert_eq!(enqueue_missing(&s).unwrap(), 0, "a recorded failure is not retried");
        assert!(set_settings(&s, ImageSettings { save: true, max_mb: 0 }).is_err());
        set_settings(&s, ImageSettings { save: false, max_mb: 8 }).unwrap();
        assert_eq!(settings(&s).unwrap(), ImageSettings { save: false, max_mb: 8 });
        s.exec_for_test("DELETE FROM article_images");
        assert_eq!(enqueue_missing(&s).unwrap(), 0, "off: nothing queued");
    }
}
