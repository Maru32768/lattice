//! Automatic backup to Cloudflare R2 through its S3-compatible API. Signs requests with AWS
//! SigV4 by hand (no AWS SDK). The bucket is managed in `infra/r2`; retention is by generation
//! count, enforced here after each upload (R2 lifecycle rules can only expire by age).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::backup;
use crate::msg;
use crate::store::{Store, hex, sha256_hex};
use ts_rs::TS;

pub const SECRET_KEY: &str = "secret.r2_secret_access_key";
const ENABLED: &str = "r2.enabled";
const ACCOUNT_ID: &str = "r2.account_id";
const BUCKET: &str = "r2.bucket";
const ACCESS_KEY_ID: &str = "r2.access_key_id";
const INTERVAL_HOURS: &str = "r2.interval_hours";
const LAST_SUCCESS: &str = "r2.last_success";
const LAST_ATTEMPT: &str = "r2.last_attempt";
const LAST_KEY: &str = "r2.last_key";
const LAST_ERROR: &str = "r2.last_error";
const KEEP: &str = "r2.keep_generations";
const LAST_PRUNE_ERROR: &str = "r2.last_prune_error";

const DEFAULT_INTERVAL_HOURS: u64 = 24;
const CHECK_EVERY: Duration = Duration::from_secs(15 * 60);
/// A failed backup is retried after this long, not on every check.
const RETRY_AFTER_SECS: u64 = 3600;
/// R2 requires equal-sized parts (except the last), at least 5 MiB. 64 MiB × 10,000 parts ≈ 640 GB.
const PART_SIZE: u64 = 64 * 1024 * 1024;
const REGION: &str = "auto";
const TMP_PREFIX: &str = "r2-upload-";

static RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct R2Status {
    pub enabled: bool,
    pub account_id: String,
    pub bucket: String,
    pub access_key_id: String,
    pub interval_hours: u64,
    pub keep_generations: u64,
    pub has_secret: bool,
    pub last_success: Option<u64>,
    pub last_key: Option<String>,
    pub last_error: Option<String>,
    /// The last upload succeeded but deleting old generations failed.
    pub last_prune_error: Option<String>,
    pub running: bool,
}

#[derive(Debug, Deserialize, TS)]
#[ts(export)]
pub struct R2Settings {
    pub enabled: bool,
    pub account_id: String,
    pub bucket: String,
    pub access_key_id: String,
    pub interval_hours: u64,
    pub keep_generations: u64,
    /// `None` or empty keeps the stored secret.
    pub secret_access_key: Option<String>,
}

struct Creds {
    account_id: String,
    bucket: String,
    access_key_id: String,
    secret: String,
}

fn get(store: &Store, key: &str) -> Result<Option<String>, String> {
    store.setting(key).map_err(|e| e.to_string())
}

fn get_u64(store: &Store, key: &str) -> Result<Option<u64>, String> {
    Ok(get(store, key)?.and_then(|v| v.parse().ok()))
}

fn set(store: &Store, key: &str, value: Option<&str>) -> Result<(), String> {
    store.set_setting(key, value).map_err(|e| e.to_string())
}

pub fn status(store: &Store) -> Result<R2Status, String> {
    Ok(R2Status {
        enabled: get(store, ENABLED)?.as_deref() == Some("1"),
        account_id: get(store, ACCOUNT_ID)?.unwrap_or_default(),
        bucket: get(store, BUCKET)?.unwrap_or_default(),
        access_key_id: get(store, ACCESS_KEY_ID)?.unwrap_or_default(),
        interval_hours: get_u64(store, INTERVAL_HOURS)?.unwrap_or(DEFAULT_INTERVAL_HOURS),
        keep_generations: get_u64(store, KEEP)?.unwrap_or(backup::DEFAULT_KEEP),
        has_secret: get(store, SECRET_KEY)?.is_some(),
        last_success: get_u64(store, LAST_SUCCESS)?,
        last_key: get(store, LAST_KEY)?,
        last_error: get(store, LAST_ERROR)?,
        last_prune_error: get(store, LAST_PRUNE_ERROR)?,
        running: RUNNING.load(Ordering::SeqCst),
    })
}

fn valid_account_id(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn valid_bucket(s: &str) -> bool {
    (3..=63).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn valid_key_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_alphanumeric())
}

pub fn save(store: &Store, s: R2Settings) -> Result<(), String> {
    let (account_id, bucket, key_id) = (s.account_id.trim(), s.bucket.trim(), s.access_key_id.trim());
    let secret = s.secret_access_key.as_deref().map(str::trim).filter(|v| !v.is_empty());
    if !account_id.is_empty() && !valid_account_id(account_id) {
        return Err(msg!("r2.accountId"));
    }
    if !bucket.is_empty() && !valid_bucket(bucket) {
        return Err(msg!("r2.bucket"));
    }
    if !key_id.is_empty() && !valid_key_id(key_id) {
        return Err(msg!("r2.accessKeyId"));
    }
    if secret.is_some_and(|v| v.chars().any(|c| !c.is_ascii_graphic())) {
        return Err(msg!("r2.secret"));
    }
    if !(1..=24 * 30).contains(&s.interval_hours) {
        return Err(msg!("r2.interval"));
    }
    backup::check_keep(s.keep_generations)?;
    let has_secret = secret.is_some() || get(store, SECRET_KEY)?.is_some();
    if s.enabled && (account_id.is_empty() || bucket.is_empty() || key_id.is_empty() || !has_secret) {
        return Err(msg!("r2.incomplete"));
    }
    let opt = |v: &str| (!v.is_empty()).then(|| v.to_string());
    set(store, ENABLED, s.enabled.then_some("1"))?;
    set(store, ACCOUNT_ID, opt(account_id).as_deref())?;
    set(store, BUCKET, opt(bucket).as_deref())?;
    set(store, ACCESS_KEY_ID, opt(key_id).as_deref())?;
    set(store, INTERVAL_HOURS, Some(&s.interval_hours.to_string()))?;
    set(store, KEEP, Some(&s.keep_generations.to_string()))?;
    if let Some(v) = secret {
        set(store, SECRET_KEY, Some(v))?;
    }
    Ok(())
}

/// Deletes the stored secret and turns automatic backup off (it cannot run without one).
pub fn clear_secret(store: &Store) -> Result<(), String> {
    set(store, SECRET_KEY, None)?;
    set(store, ENABLED, None)
}

fn creds(store: &Store) -> Result<Creds, String> {
    let need = |k: &str| get(store, k)?.ok_or_else(|| format!("R2 setting {k} is not set"));
    Ok(Creds { account_id: need(ACCOUNT_ID)?, bucket: need(BUCKET)?, access_key_id: need(ACCESS_KEY_ID)?, secret: need(SECRET_KEY)? })
}

fn due(store: &Store, now: u64) -> Result<bool, String> {
    let s = status(store)?;
    let complete = !s.account_id.is_empty() && !s.bucket.is_empty() && !s.access_key_id.is_empty() && s.has_secret;
    let after_success = s.last_success.is_none_or(|t| now >= t + s.interval_hours * 3600);
    let after_failure = get_u64(store, LAST_ATTEMPT)?.is_none_or(|t| s.last_success >= Some(t) || now >= t + RETRY_AFTER_SECS);
    Ok(s.enabled && complete && after_success && after_failure)
}

/// Checks every `CHECK_EVERY` whether a backup is due. Due-ness comes from the stored
/// last-success time, so the schedule survives restarts.
pub async fn run_scheduler(store: Arc<Store>, db_path: PathBuf, tmp_dir: PathBuf) {
    let http = client();
    loop {
        tokio::time::sleep(CHECK_EVERY).await;
        match due(&store, unix_now()) {
            Ok(true) => {
                let _ = backup_now(&store, &http, &db_path, &tmp_dir).await;
            }
            Ok(false) => {}
            Err(e) => log::warn!("r2 schedule check: {e}"),
        }
    }
}

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(15 * 60)) // per request, i.e. per 64 MiB part
        .build()
        .expect("static client config")
}

/// Copies the database (secrets stripped), gzips it and uploads it, then deletes this device's
/// objects beyond the newest `keep_generations`. Returns the object key. A failed deletion is
/// recorded in `last_prune_error` but does not fail the backup.
/// The copy reads through its own connection so app commands are not blocked meanwhile.
pub async fn backup_now(store: &Store, http: &reqwest::Client, db_path: &Path, tmp_dir: &Path) -> Result<String, String> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err(msg!("r2.running"));
    }
    let now = unix_now();
    let tmp = tmp_dir.join(format!("{TMP_PREFIX}{now}.db"));
    let gz = tmp_dir.join(format!("{TMP_PREFIX}{now}.db.gz"));
    let prefix = device_prefix(&device_name());
    let key = object_key(&prefix, now);
    let result = async {
        let c = creds(store)?;
        let keep = get_u64(store, KEEP)?.unwrap_or(backup::DEFAULT_KEEP);
        set(store, LAST_ATTEMPT, Some(&now.to_string()))?;
        let (db, dir, t, g) = (db_path.to_path_buf(), tmp_dir.to_path_buf(), tmp.clone(), gz.clone());
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            // Leftovers of a run killed mid-way can be several GB each.
            for e in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
                if e.file_name().to_string_lossy().starts_with(TMP_PREFIX) {
                    let _ = std::fs::remove_file(e.path());
                }
            }
            Store::open(&db).and_then(|s| s.backup_to(&t)).map_err(|e| format!("database copy failed: {e}"))?;
            gzip(&t, &g).map_err(|e| format!("compression failed: {e}"))
        })
        .await
        .map_err(|e| e.to_string())??;
        let _ = std::fs::remove_file(&tmp);
        upload(http, &c, &key, &gz).await?;
        Ok::<_, String>((c, keep))
    }
    .await;
    let _ = std::fs::remove_file(&tmp);
    let _ = std::fs::remove_file(&gz);
    let pruned = match &result {
        Ok((c, keep)) => Some(prune(http, c, &prefix, *keep, &key).await),
        Err(_) => None,
    };
    RUNNING.store(false, Ordering::SeqCst);
    match result {
        Ok(_) => {
            log::info!("r2 backup uploaded: {key}");
            set(store, LAST_SUCCESS, Some(&unix_now().to_string()))?;
            set(store, LAST_KEY, Some(&key))?;
            set(store, LAST_ERROR, None)?;
            match pruned {
                Some(Err(e)) => {
                    log::warn!("r2 prune failed: {e}");
                    set(store, LAST_PRUNE_ERROR, Some(&e))?;
                }
                Some(Ok(n)) => {
                    if n > 0 {
                        log::info!("r2: deleted {n} old backups");
                    }
                    set(store, LAST_PRUNE_ERROR, None)?;
                }
                None => {}
            }
            Ok(key)
        }
        Err(e) => {
            log::warn!("r2 backup failed: {e}");
            set(store, LAST_ERROR, Some(&e))?;
            Err(e)
        }
    }
}

fn gzip(src: &Path, dst: &Path) -> std::io::Result<()> {
    let out = std::io::BufWriter::new(std::fs::File::create(dst)?);
    let mut enc = flate2::write::GzEncoder::new(out, flate2::Compression::default());
    std::io::copy(&mut std::fs::File::open(src)?, &mut enc)?;
    enc.finish()?.flush()
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn device_name() -> String {
    let raw = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_default();
    let name: String = raw.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(63).collect();
    if name.is_empty() {
        "device".into()
    } else {
        name.to_ascii_lowercase()
    }
}

fn device_prefix(device: &str) -> String {
    format!("lattice/{device}/")
}

/// The fixed-width UTC stamp makes keys sort chronologically as strings.
fn object_key(prefix: &str, now: u64) -> String {
    format!("{prefix}lattice-{}.db.gz", amz_date(now))
}

/// Only keys shaped exactly like `object_key` output, so nothing else in the bucket is deleted.
fn is_backup_key(key: &str, prefix: &str) -> bool {
    let Some(stamp) = key.strip_prefix(prefix).and_then(|k| k.strip_prefix("lattice-")).and_then(|k| k.strip_suffix(".db.gz")) else {
        return false;
    };
    let b = stamp.as_bytes();
    b.len() == 16
        && b.iter().enumerate().all(|(i, c)| match i {
            8 => *c == b'T',
            15 => *c == b'Z',
            _ => c.is_ascii_digit(),
        })
}

/// Deletes this device's backups beyond the newest `keep`, never `current`. Returns how many.
async fn prune(http: &reqwest::Client, c: &Creds, prefix: &str, keep: u64, current: &str) -> Result<usize, String> {
    let mut keys = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let mut query = vec![("list-type", "2"), ("prefix", prefix)];
        if let Some(t) = &token {
            query.push(("continuation-token", t));
        }
        let body = send(http, c, "GET", "", &query, Vec::new()).await?.text().await.map_err(|e| e.to_string())?;
        let page = parse_list(&body)?;
        keys.extend(page.keys);
        match page.next {
            Some(t) => token = Some(t),
            None => break,
        }
    }
    keys.retain(|k| is_backup_key(k, prefix));
    let old = backup::stale(keys, keep, &current.to_string());
    for (i, key) in old.iter().enumerate() {
        send(http, c, "DELETE", key, &[], Vec::new()).await.map_err(|e| msg!("r2.pruneStopped", error = e, done = i, total = old.len()))?;
    }
    Ok(old.len())
}

#[derive(Debug, PartialEq)]
struct ListPage {
    keys: Vec<String>,
    /// Continuation token when the listing is truncated.
    next: Option<String>,
}

/// ListObjectsV2 response. S3 elements carry no attributes, so tag matching is enough; text is
/// unescaped with quick-xml (keys may contain `&amp;` and character references).
fn parse_list(xml: &str) -> Result<ListPage, String> {
    if !xml.contains("<ListBucketResult") {
        return Err(format!("unexpected ListObjectsV2 response: {}", truncate(xml)));
    }
    let text = |s: &str, tag: &str| -> Result<Option<String>, String> {
        xml_text(s, tag).map(|v| quick_xml::escape::unescape(&v).map(|u| u.into_owned()).map_err(|e| format!("bad XML in <{tag}>: {e}"))).transpose()
    };
    let mut keys = Vec::new();
    for item in xml.split("<Contents>").skip(1) {
        let item = &item[..item.find("</Contents>").ok_or("unterminated <Contents>")?];
        keys.push(text(item, "Key")?.ok_or("<Contents> without <Key>")?);
    }
    let next = if text(xml, "IsTruncated")?.as_deref() == Some("true") {
        Some(text(xml, "NextContinuationToken")?.filter(|t| !t.is_empty()).ok_or("truncated listing without NextContinuationToken")?)
    } else {
        None
    };
    Ok(ListPage { keys, next })
}

/// `YYYYMMDDTHHMMSSZ` in UTC.
fn amz_date(secs: u64) -> String {
    let (days, rem) = ((secs / 86400) as i64, secs % 86400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 {
        mp + 3
    } else {
        mp - 9
    };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}{m:02}{d:02}T{:02}{:02}{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

async fn upload(http: &reqwest::Client, c: &Creds, key: &str, path: &Path) -> Result<(), String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    if size <= PART_SIZE {
        let body = read_part(&mut file)?;
        return send(http, c, "PUT", key, &[], body).await.map(drop);
    }
    let created = send(http, c, "POST", key, &[("uploads", "")], Vec::new()).await?;
    let upload_id = xml_text(&created.text().await.map_err(|e| e.to_string())?, "UploadId").ok_or("CreateMultipartUpload returned no UploadId")?;
    let parts = async {
        let mut xml = String::from("<CompleteMultipartUpload>");
        for n in 1.. {
            let body = read_part(&mut file)?;
            if body.is_empty() {
                break;
            }
            let resp = send(http, c, "PUT", key, &[("partNumber", &n.to_string()), ("uploadId", &upload_id)], body).await?;
            let etag = resp.headers().get("etag").and_then(|v| v.to_str().ok()).ok_or("UploadPart returned no ETag")?;
            xml += &format!("<Part><PartNumber>{n}</PartNumber><ETag>{etag}</ETag></Part>");
        }
        xml += "</CompleteMultipartUpload>";
        let done = send(http, c, "POST", key, &[("uploadId", &upload_id)], xml.into_bytes()).await?;
        // S3 may report a failed completion with 200 and an <Error> body.
        let body = done.text().await.map_err(|e| e.to_string())?;
        if body.contains("<Error>") {
            Err(format!("CompleteMultipartUpload failed: {}", truncate(&body)))
        } else {
            Ok(())
        }
    }
    .await;
    if parts.is_err() {
        // Best effort; the bucket's lifecycle rule also aborts stale uploads.
        let _ = send(http, c, "DELETE", key, &[("uploadId", &upload_id)], Vec::new()).await;
    }
    parts
}

fn read_part(file: &mut std::fs::File) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    file.take(PART_SIZE).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

fn xml_text(xml: &str, tag: &str) -> Option<String> {
    let start = xml.find(&format!("<{tag}>"))? + tag.len() + 2;
    let len = xml[start..].find(&format!("</{tag}>"))?;
    Some(xml[start..start + len].to_string())
}

fn truncate(s: &str) -> &str {
    &s[..s.floor_char_boundary(500)]
}

async fn send(http: &reqwest::Client, c: &Creds, method: &str, key: &str, query: &[(&str, &str)], body: Vec<u8>) -> Result<reqwest::Response, String> {
    let req = build(c, method, key, query, &sha256_hex(&body), unix_now());
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut rb = http.request(method, &req.url).body(body);
    for (k, v) in &req.headers {
        rb = rb.header(*k, v);
    }
    let resp = rb.send().await.map_err(|e| format!("R2 request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("R2 HTTP {status}: {}", truncate(&text)));
    }
    Ok(resp)
}

#[derive(Debug)]
struct Signed {
    url: String,
    headers: Vec<(&'static str, String)>,
}

/// Path-style request to `https://<account>.r2.cloudflarestorage.com/<bucket>/<key>`; an empty
/// key addresses the bucket itself (`/<bucket>`, e.g. ListObjectsV2).
fn build(c: &Creds, method: &str, key: &str, query: &[(&str, &str)], payload_hash: &str, now: u64) -> Signed {
    let host = format!("{}.r2.cloudflarestorage.com", c.account_id);
    let bucket = uri_encode(&c.bucket, false);
    let path = if key.is_empty() {
        format!("/{bucket}")
    } else {
        format!("/{bucket}/{}", uri_encode(key, true))
    };
    let query = canonical_query(query);
    let date = amz_date(now);
    let auth = authorization(
        method,
        &path,
        &query,
        &[("host", &host), ("x-amz-content-sha256", payload_hash), ("x-amz-date", &date)],
        payload_hash,
        &date,
        REGION,
        &c.access_key_id,
        &c.secret,
    );
    let url = if query.is_empty() {
        format!("https://{host}{path}")
    } else {
        format!("https://{host}{path}?{query}")
    };
    Signed { url, headers: vec![("x-amz-date", date), ("x-amz-content-sha256", payload_hash.to_string()), ("authorization", auth)] }
}

fn canonical_query(query: &[(&str, &str)]) -> String {
    let mut pairs: Vec<String> = query.iter().map(|(k, v)| format!("{}={}", uri_encode(k, false), uri_encode(v, false))).collect();
    pairs.sort();
    pairs.join("&")
}

fn uri_encode(s: &str, keep_slash: bool) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            b'/' if keep_slash => "/".into(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// SigV4 `Authorization` header for service `s3`. `headers` are the signed headers, lowercase.
#[allow(clippy::too_many_arguments, reason = "the SigV4 inputs, named as in the AWS spec")]
fn authorization(
    method: &str,
    path: &str,
    canonical_query: &str,
    headers: &[(&str, &str)],
    payload_hash: &str,
    amz_date: &str,
    region: &str,
    access_key_id: &str,
    secret: &str,
) -> String {
    let mut headers = headers.to_vec();
    headers.sort();
    let canonical_headers: String = headers.iter().map(|(k, v)| format!("{k}:{}\n", v.trim())).collect();
    let signed_headers = headers.iter().map(|(k, _)| *k).collect::<Vec<_>>().join(";");
    let request = format!("{method}\n{path}\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}");
    let scope = format!("{}/{region}/s3/aws4_request", &amz_date[..8]);
    let to_sign = format!("AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}", sha256_hex(&request));
    let mut key = hmac(format!("AWS4{secret}").as_bytes(), &amz_date.as_bytes()[..8]);
    for part in [region, "s3", "aws4_request"] {
        key = hmac(&key, part.as_bytes());
    }
    let signature = hex(&hmac(&key, to_sign.as_bytes()));
    format!("AWS4-HMAC-SHA256 Credential={access_key_id}/{scope}, SignedHeaders={signed_headers}, Signature={signature}")
}

/// HMAC-SHA256 (RFC 2104); a few lines instead of another crate.
fn hmac(key: &[u8], msg: &[u8]) -> [u8; 32] {
    let mut k = [0u8; 64];
    if key.len() > 64 {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let pad = |x: u8| k.iter().map(|b| b ^ x).collect::<Vec<u8>>();
    let inner = Sha256::new().chain_update(pad(0x36)).chain_update(msg).finalize();
    Sha256::new().chain_update(pad(0x5c)).chain_update(inner).finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    const EMPTY_SHA: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const AWS_KEY: &str = "AKIAIOSFODNN7EXAMPLE";
    const AWS_SECRET: &str = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

    fn aws_sig(path: &str, query: &[(&str, &str)], extra: &[(&str, &str)]) -> String {
        let mut headers = vec![("host", "examplebucket.s3.amazonaws.com"), ("x-amz-content-sha256", EMPTY_SHA), ("x-amz-date", "20130524T000000Z")];
        headers.extend_from_slice(extra);
        let auth = authorization("GET", path, &canonical_query(query), &headers, EMPTY_SHA, "20130524T000000Z", "us-east-1", AWS_KEY, AWS_SECRET);
        auth.rsplit("Signature=").next().unwrap().to_string()
    }

    // Test vectors from the AWS S3 docs, "Signature Calculations for the Authorization Header".
    #[test]
    fn sigv4_matches_aws_examples() {
        assert_eq!(aws_sig("/test.txt", &[], &[("range", "bytes=0-9")]), "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
        assert_eq!(aws_sig("/", &[("lifecycle", "")], &[]), "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543");
        assert_eq!(aws_sig("/", &[("prefix", "J"), ("max-keys", "2")], &[]), "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
    }

    #[test]
    fn builds_path_style_r2_request() {
        let c =
            Creds { account_id: "0123456789abcdef0123456789abcdef".into(), bucket: "lattice-backup".into(), access_key_id: "AKID".into(), secret: "s".into() };
        let r = build(&c, "PUT", "lattice/pc/lattice-20130524T000000Z.db.gz", &[("uploadId", "a/b+c"), ("partNumber", "2")], EMPTY_SHA, 1_369_353_600);
        assert_eq!(
            r.url,
            "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/lattice-backup/lattice/pc/lattice-20130524T000000Z.db.gz?partNumber=2&uploadId=a%2Fb%2Bc"
        );
        assert_eq!(r.headers[0], ("x-amz-date", "20130524T000000Z".to_string()));
        assert_eq!(r.headers[1].1, EMPTY_SHA);
        let auth = &r.headers[2].1;
        assert!(
            auth.starts_with("AWS4-HMAC-SHA256 Credential=AKID/20130524/auto/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature="),
            "{auth}"
        );
        assert_eq!(auth.rsplit('=').next().unwrap().len(), 64);
    }

    #[test]
    fn utc_dates_and_keys() {
        assert_eq!(amz_date(0), "19700101T000000Z");
        assert_eq!(amz_date(1_369_353_600), "20130524T000000Z");
        assert_eq!(amz_date(951_782_400 + 86399), "20000229T235959Z");
        assert_eq!(object_key(&device_prefix("pc"), 0), "lattice/pc/lattice-19700101T000000Z.db.gz");
        // Lexicographic order of keys is chronological order.
        let keys: Vec<String> = [0, 9, 10, 86_399, 86_400, 951_782_400, 4_102_444_800].iter().map(|t| object_key("p/", *t)).collect();
        assert!(keys.windows(2).all(|w| w[0] < w[1]), "{keys:?}");
        assert_eq!(xml_text("<a><UploadId>x-1</UploadId></a>", "UploadId").as_deref(), Some("x-1"));
    }

    #[test]
    fn settings_hide_secret_and_drive_schedule() {
        assert!(SECRET_KEY.starts_with(crate::store::SECRET_PREFIX), "backups must strip the secret");
        let s = Store::open_in_memory().unwrap();
        assert!(save(&s, input_with(true)).is_err(), "enabling without a secret is rejected");
        save(&s, R2Settings { secret_access_key: Some("top-secret".into()), ..input_with(true) }).unwrap();
        let st = status(&s).unwrap();
        assert!(st.enabled && st.has_secret);
        assert!(!format!("{st:?}").contains("top-secret"));
        save(&s, input_with(true)).unwrap(); // empty secret keeps the stored one
        assert_eq!(s.setting(SECRET_KEY).unwrap().as_deref(), Some("top-secret"));
        assert!(save(&s, R2Settings { bucket: "Bad_Bucket".into(), ..input_with(true) }).is_err());

        let now = 1_000_000;
        assert!(due(&s, now).unwrap(), "never backed up");
        s.set_setting(LAST_ATTEMPT, Some(&now.to_string())).unwrap();
        assert!(!due(&s, now + 60).unwrap(), "failed just now: wait before retrying");
        assert!(due(&s, now + RETRY_AFTER_SECS).unwrap());
        s.set_setting(LAST_SUCCESS, Some(&now.to_string())).unwrap();
        assert!(!due(&s, now + 23 * 3600).unwrap());
        assert!(due(&s, now + 24 * 3600).unwrap());
        save(&s, input_with(false)).unwrap();
        assert!(!due(&s, now + 48 * 3600).unwrap(), "disabled");
    }

    fn input_with(enabled: bool) -> R2Settings {
        R2Settings {
            enabled,
            account_id: "0123456789abcdef0123456789abcdef".into(),
            bucket: "lattice-backup".into(),
            access_key_id: "abc123".into(),
            interval_hours: 24,
            keep_generations: 30,
            secret_access_key: None,
        }
    }

    #[test]
    fn generations_and_clearing_secret() {
        let s = Store::open_in_memory().unwrap();
        assert_eq!(status(&s).unwrap().keep_generations, 30);
        assert!(save(&s, R2Settings { keep_generations: 0, ..input_with(false) }).is_err());
        save(&s, R2Settings { keep_generations: 5, secret_access_key: Some("k".into()), ..input_with(true) }).unwrap();
        assert_eq!(status(&s).unwrap().keep_generations, 5);
        clear_secret(&s).unwrap();
        let st = status(&s).unwrap();
        assert!(!st.has_secret && !st.enabled);
        assert_eq!((st.account_id.as_str(), st.access_key_id.as_str()), ("0123456789abcdef0123456789abcdef", "abc123"));
    }

    fn test_creds() -> Creds {
        Creds { account_id: "0123456789abcdef0123456789abcdef".into(), bucket: "lattice-backup".into(), access_key_id: "AKID".into(), secret: "s".into() }
    }

    fn signature(auth: &str) -> &str {
        auth.rsplit("Signature=").next().unwrap()
    }

    #[test]
    fn signs_list_and_delete_requests() {
        let c = test_creds();
        let host = "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com";
        // Fixed vectors calculated independently with Node crypto's SHA-256/HMAC, region auto,
        // service s3, the empty body hash, and the canonical GET/DELETE requests below.
        let list = build(&c, "GET", "", &[("list-type", "2"), ("prefix", "lattice/pc/"), ("continuation-token", "1x/y+z=")], EMPTY_SHA, 1_369_353_600);
        let query = "continuation-token=1x%2Fy%2Bz%3D&list-type=2&prefix=lattice%2Fpc%2F";
        assert_eq!(list.url, format!("https://{host}/lattice-backup?{query}"));
        assert_eq!(signature(&list.headers[2].1), "83029a423a9ba72b09d90e6807bcf5a355757e9b7155ee02e8c372ea1bde9f7b");

        let key = "lattice/pc/lattice-20130524T000000Z.db.gz";
        let path = format!("/lattice-backup/{key}");
        let del = build(&c, "DELETE", key, &[], EMPTY_SHA, 1_369_353_600);
        assert_eq!(del.url, format!("https://{host}{path}"));
        assert_eq!(signature(&del.headers[2].1), "ab6b504a8aee9c80af7fda3263fc43a8c74f4671acd13799e1a6923e53663fc7");
    }

    #[test]
    fn parses_list_pages() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>lattice-backup</Name><Prefix>lattice/pc/</Prefix><KeyCount>2</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>true</IsTruncated>
  <Contents><Key>lattice/pc/lattice-20261001T000000Z.db.gz</Key><LastModified>2026-10-01T00:00:01.000Z</LastModified><ETag>"a"</ETag><Size>10</Size><StorageClass>STANDARD</StorageClass></Contents>
  <Contents>
    <Key>lattice/pc/a&amp;b&#x41;.txt</Key><Size>1</Size>
  </Contents>
  <NextContinuationToken>tok/+=&amp;</NextContinuationToken></ListBucketResult>"#;
        assert_eq!(
            parse_list(xml).unwrap(),
            ListPage { keys: vec!["lattice/pc/lattice-20261001T000000Z.db.gz".into(), "lattice/pc/a&bA.txt".into()], next: Some("tok/+=&".into()) }
        );
        let last = "<ListBucketResult><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>";
        assert_eq!(parse_list(last).unwrap(), ListPage { keys: vec![], next: None });
        assert!(parse_list("<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>").is_err(), "no token: would loop forever");
        assert!(parse_list("<Error><Code>AccessDenied</Code></Error>").is_err());
    }

    #[test]
    fn selects_old_generations_of_this_device_only() {
        let p = device_prefix("pc");
        let key = |t| object_key(&p, t);
        let current = key(500);
        let mut listed: Vec<String> = [100, 400, 200, 300].map(key).to_vec();
        listed.extend([
            current.clone(),
            "lattice/pc/notes.txt".into(),
            "lattice/pc/lattice-2026.db.gz".into(),
            "lattice/pc/sub/lattice-20261001T000000Z.db.gz".into(),
        ]);
        listed.push(object_key(&device_prefix("pc-2"), 50));
        listed.retain(|k| is_backup_key(k, &p));
        assert_eq!(backup::stale(listed.clone(), 3, &current), vec![key(200), key(100)]);
        assert_eq!(backup::stale(listed, 1, &current), vec![key(400), key(300), key(200), key(100)]);
    }
}
