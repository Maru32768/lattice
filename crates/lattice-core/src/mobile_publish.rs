//! The snapshot for a phone while the PC is off (G47, design-review §32): the page, the list and
//! the articles as objects in an R2 bucket, read through a small Worker (`infra/mobile`). What the
//! phone does meanwhile waits in the bucket's `inbox/`, and this library applies it when the PC is on.
//! Only this PC writes the documents, so there is nothing to merge.

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;
use ts_rs::TS;

use crate::mobile::{self, Effects, MobileOp, Outcome, blocking};
use crate::msg;
use crate::r2::{self, Creds, get, set};
use crate::store::{Store, sha256_hex};

const ENABLED: &str = "mobile.snapshot.enabled";
const ACCOUNT_ID: &str = "mobile.snapshot.account_id";
const BUCKET: &str = "mobile.snapshot.bucket";
const ACCESS_KEY_ID: &str = "mobile.snapshot.access_key_id";
const WORKER_URL: &str = "mobile.snapshot.worker_url";
const SECRET_KEY: &str = "secret.mobile_snapshot_secret_access_key";
const LAST_PUBLISH: &str = "mobile.snapshot.last_publish";
const LAST_ERROR: &str = "mobile.snapshot.last_error";
const LAST_REJECTED: &str = "mobile.snapshot.last_rejected";

const AUTH_KEY: &str = "auth.json";
const INDEX_KEY: &str = "index.json";
const INBOX_PREFIX: &str = "inbox/";

/// What the bucket holds once the snapshot is turned off: the Worker answers every token with 401.
const NO_TOKEN: &[u8] = br#"{"token_hash":null,"live_origin":null}"#;

/// What the phone did reaches the PC within this.
const INBOX_EVERY: Duration = Duration::from_secs(5 * 60);
/// What the PC did reaches the phone within this. Each pass reads every article to see whether it changed.
const PUBLISH_EVERY_SECS: u64 = 15 * 60;
/// Past the busy first minute of a start, as for the backup.
const FIRST_CHECK: Duration = Duration::from_secs(90);

/// For the settings screen only: `run_scheduler` runs one pass at a time by itself.
static RUNNING: AtomicBool = AtomicBool::new(false);

fn err(e: impl ToString) -> String {
    e.to_string()
}

fn unix_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or_default()
}

// ---- settings -------------------------------------------------------------------------------

#[derive(Debug, Deserialize, TS)]
#[ts(export)]
pub struct SnapshotSettings {
    pub enabled: bool,
    pub account_id: String,
    pub bucket: String,
    pub access_key_id: String,
    /// `None` or empty keeps the stored secret.
    pub secret_access_key: Option<String>,
    /// The Worker's address, which the phone opens.
    pub worker_url: String,
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct SnapshotStatus {
    pub enabled: bool,
    pub account_id: String,
    pub bucket: String,
    pub access_key_id: String,
    pub worker_url: String,
    pub has_secret: bool,
    pub running: bool,
    /// Unix seconds of the last complete pass.
    #[ts(type = "number | null")]
    pub last_publish: Option<u64>,
    pub last_error: Option<String>,
    /// Why the last operation from the inbox could not apply. The phone was told only that it was left there.
    pub last_rejected: Option<String>,
}

pub fn status(store: &Store) -> Result<SnapshotStatus, String> {
    let text = |key| get(store, key).map(Option::unwrap_or_default);
    Ok(SnapshotStatus {
        enabled: get(store, ENABLED)?.is_some(),
        account_id: text(ACCOUNT_ID)?,
        bucket: text(BUCKET)?,
        access_key_id: text(ACCESS_KEY_ID)?,
        worker_url: text(WORKER_URL)?,
        has_secret: get(store, SECRET_KEY)?.is_some(),
        running: RUNNING.load(Ordering::SeqCst),
        last_publish: get(store, LAST_PUBLISH)?.and_then(|v| v.parse().ok()),
        last_error: get(store, LAST_ERROR)?,
        last_rejected: get(store, LAST_REJECTED)?,
    })
}

/// The origin of the Worker's page, which alone may call the PC's server from another origin.
pub fn worker_origin(store: &Store) -> Result<Option<String>, String> {
    Ok(get(store, WORKER_URL)?.and_then(|u| url::Url::parse(&u).ok()).map(|u| u.origin().ascii_serialization()))
}

pub fn save(store: &Store, s: &SnapshotSettings) -> Result<(), String> {
    let (account_id, bucket, key_id) = (s.account_id.trim(), s.bucket.trim(), s.access_key_id.trim());
    let secret = s.secret_access_key.as_deref().map(str::trim).filter(|v| !v.is_empty());
    r2::check_credentials(account_id, bucket, key_id, secret)?;
    let worker_url = mobile::clean_public_url(&s.worker_url)?;
    let has_secret = secret.is_some() || get(store, SECRET_KEY)?.is_some();
    if s.enabled && (account_id.is_empty() || bucket.is_empty() || key_id.is_empty() || !has_secret || worker_url.is_empty()) {
        return Err(msg!("mobile.snapshotIncomplete"));
    }
    // A different bucket holds nothing yet: no QR code until a pass has filled it.
    if get(store, ACCOUNT_ID)?.unwrap_or_default() != account_id || get(store, BUCKET)?.unwrap_or_default() != bucket {
        forget_published(store)?;
        set(store, LAST_PUBLISH, None)?;
        set(store, LAST_ERROR, None)?;
    }
    let opt = |v: &str| (!v.is_empty()).then(|| v.to_string());
    set(store, ENABLED, s.enabled.then_some("1"))?;
    set(store, ACCOUNT_ID, opt(account_id).as_deref())?;
    set(store, BUCKET, opt(bucket).as_deref())?;
    set(store, ACCESS_KEY_ID, opt(key_id).as_deref())?;
    set(store, WORKER_URL, opt(&worker_url).as_deref())?;
    if let Some(v) = secret {
        set(store, SECRET_KEY, Some(v))?;
    }
    clear_rejected(store)
}

/// The reader has acted since: the warning has done its work.
pub fn clear_rejected(store: &Store) -> Result<(), String> {
    set(store, LAST_REJECTED, None)
}

/// The next pass uploads everything again, as if the bucket were empty.
pub fn forget_published(store: &Store) -> Result<(), String> {
    store.conn().execute("DELETE FROM mobile_published", []).map(drop).map_err(err)
}

/// The bucket's credentials if they are all there, and whether publishing is on.
fn creds(store: &Store) -> Result<Option<(Creds, bool)>, String> {
    let (Some(account_id), Some(bucket), Some(access_key_id), Some(secret)) =
        (get(store, ACCOUNT_ID)?, get(store, BUCKET)?, get(store, ACCESS_KEY_ID)?, get(store, SECRET_KEY)?)
    else {
        return Ok(None);
    };
    Ok(Some((Creds { account_id, bucket, access_key_id, secret }, get(store, ENABLED)?.is_some())))
}

// ---- the bucket -----------------------------------------------------------------------------

/// What a pass needs of a bucket. Tests run against one in memory.
pub(crate) trait Bucket {
    async fn put(&self, key: &str, body: Vec<u8>) -> Result<(), String>;
    async fn get(&self, key: &str) -> Result<Vec<u8>, String>;
    async fn delete(&self, key: &str) -> Result<(), String>;
    async fn list(&self, prefix: &str) -> Result<Vec<String>, String>;
}

struct R2Bucket {
    http: reqwest::Client,
    creds: Creds,
}

impl Bucket for R2Bucket {
    async fn put(&self, key: &str, body: Vec<u8>) -> Result<(), String> {
        r2::send(&self.http, &self.creds, "PUT", key, &[], body).await.map(drop)
    }

    async fn get(&self, key: &str) -> Result<Vec<u8>, String> {
        let response = r2::send(&self.http, &self.creds, "GET", key, &[], Vec::new()).await?;
        response.bytes().await.map(|b| b.to_vec()).map_err(err)
    }

    async fn delete(&self, key: &str) -> Result<(), String> {
        r2::send(&self.http, &self.creds, "DELETE", key, &[], Vec::new()).await.map(drop)
    }

    async fn list(&self, prefix: &str) -> Result<Vec<String>, String> {
        r2::list_keys(&self.http, &self.creds, prefix).await
    }
}

// ---- a pass ---------------------------------------------------------------------------------

/// A built file of the page, by its name under `page/`.
pub type PageFile = (&'static str, &'static [u8]);

/// Clears `RUNNING` however a pass ends.
struct Running;
impl Drop for Running {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::SeqCst)
    }
}

/// Applies what waits in the inbox, oldest first (the Worker names objects by arrival). An operation is
/// deleted once it has applied or can never apply; a store error leaves it for the next time. Returns how many applied.
pub(crate) async fn take_inbox<B: Bucket>(store: &Arc<Store>, bucket: &B, on_applied: &(dyn Fn(&Effects) + Send + Sync)) -> Result<usize, String> {
    let mut keys = bucket.list(INBOX_PREFIX).await?;
    keys.sort();
    let mut applied = 0;
    for key in keys {
        let body = bucket.get(&key).await?;
        let store = store.clone();
        let outcome = blocking(move || {
            let outcome = match serde_json::from_slice::<MobileOp>(&body) {
                Ok(op) => mobile::apply(&store, &op)?,
                // Newer than this build, or not ours: nothing here can ever read it.
                Err(e) => {
                    log::warn!("mobile inbox: {e}");
                    Outcome::Rejected(msg!("mobile.badOp"))
                }
            };
            if let Outcome::Rejected(message) = &outcome {
                set(&store, LAST_REJECTED, Some(message))?;
            }
            Ok(outcome)
        })
        .await?;
        if let Outcome::Applied(effects) = &outcome {
            on_applied(effects);
            applied += 1;
        }
        bucket.delete(&key).await?;
    }
    Ok(applied)
}

/// Uploads `raw` under `key` unless the bucket has what `hash` stands for. Compressed when `gzip`, which the Worker assumes by the key.
async fn put_if_changed<B: Bucket>(store: &Arc<Store>, bucket: &B, key: String, hash: String, raw: Vec<u8>, gzip: bool) -> Result<(), String> {
    let (s, k, h) = (store.clone(), key.clone(), hash.clone());
    let body = blocking(move || {
        let known: Option<String> = s.conn().query_row("SELECT hash FROM mobile_published WHERE key = ?1", [&k], |r| r.get(0)).optional().map_err(err)?;
        if known.as_deref() == Some(&h) {
            return Ok(None);
        }
        Ok(Some(if gzip {
            mobile::gzip(&raw).map_err(err)?
        } else {
            raw
        }))
    })
    .await?;
    let Some(body) = body else {
        return Ok(());
    };
    bucket.put(&key, body).await?;
    let s = store.clone();
    blocking(move || s.conn().execute("INSERT OR REPLACE INTO mobile_published (key, hash) VALUES (?1, ?2)", params![key, hash]).map(drop).map_err(err)).await
}

/// An article's part of its upload. The row is left out: read state, tags and scores change often, and the list carries them.
fn article_upload(store: &Store, id: i64) -> Result<Option<(String, Vec<u8>)>, String> {
    let Some(doc) = mobile::article(store, id)? else {
        return Ok(None);
    };
    let body = serde_json::json!({
        "format": doc.format,
        "title": doc.article.title,
        "url": doc.article.original_url,
        "target": doc.target_language,
        "blocks": doc.blocks,
        "summary": doc.summary,
    });
    let hash = sha256_hex(serde_json::to_vec(&body).map_err(err)?);
    Ok(Some((hash, serde_json::to_vec(&doc).map_err(err)?)))
}

/// One complete pass. Articles go up before the list, and what is gone comes down after it, so a phone never
/// finds a listed article missing for long; if one does, it reads the list again.
pub(crate) async fn publish<B: Bucket>(store: &Arc<Store>, bucket: &B, page: &[PageFile], on_applied: &(dyn Fn(&Effects) + Send + Sync)) -> Result<(), String> {
    take_inbox(store, bucket, on_applied).await?;

    let mut live: HashSet<String> = HashSet::new();
    let s = store.clone();
    let auth = blocking(move || mobile::auth_document(&s)).await?;
    live.insert(AUTH_KEY.to_string());
    put_if_changed(store, bucket, AUTH_KEY.to_string(), sha256_hex(&auth), auth, false).await?;

    for (name, bytes) in page {
        let key = format!("page/{name}");
        live.insert(key.clone());
        put_if_changed(store, bucket, key, sha256_hex(bytes), bytes.to_vec(), !name.ends_with(".png")).await?;
    }

    let s = store.clone();
    let (index, gz) = blocking(move || {
        let index = mobile::index(&s)?;
        let gz = mobile::gzip(&serde_json::to_vec(&index).map_err(err)?).map_err(err)?;
        Ok((index, gz))
    })
    .await?;
    for id in index.articles.iter().map(|a| a.id) {
        let s = store.clone();
        let Some((hash, doc)) = blocking(move || article_upload(&s, id)).await? else {
            continue; // deleted since the list was read
        };
        let key = format!("articles/{id}.json");
        live.insert(key.clone());
        put_if_changed(store, bucket, key, hash, doc, true).await?;
    }

    // Always, unchanged or not: `generated_at` tells the phone how old the snapshot is.
    bucket.put(INDEX_KEY, gz).await?;

    let s = store.clone();
    let known: Vec<String> = blocking(move || {
        let conn = s.conn();
        let mut stmt = conn.prepare("SELECT key FROM mobile_published").map_err(err)?;
        let keys = stmt.query_map([], |r| r.get(0)).map_err(err)?.collect::<rusqlite::Result<Vec<String>>>().map_err(err)?;
        Ok(keys)
    })
    .await?;
    for key in known.into_iter().filter(|k| !live.contains(k)) {
        bucket.delete(&key).await?;
        let s = store.clone();
        blocking(move || s.conn().execute("DELETE FROM mobile_published WHERE key = ?1", [&key]).map(drop).map_err(err)).await?;
    }
    Ok(())
}

/// Takes the token out of a bucket that has one, so that turning the snapshot off also stops its readers.
async fn withdraw_token<B: Bucket>(store: &Arc<Store>, bucket: &B) -> Result<(), String> {
    let s = store.clone();
    let hash = sha256_hex(NO_TOKEN);
    let check = hash.clone();
    let needed = blocking(move || {
        let known: Option<String> = s.conn().query_row("SELECT hash FROM mobile_published WHERE key = ?1", [AUTH_KEY], |r| r.get(0)).optional().map_err(err)?;
        Ok(known.is_some_and(|k| k != check))
    })
    .await?;
    if !needed {
        return Ok(());
    }
    bucket.put(AUTH_KEY, NO_TOKEN.to_vec()).await?;
    let s = store.clone();
    blocking(move || s.conn().execute("UPDATE mobile_published SET hash = ?1 WHERE key = ?2", params![hash, AUTH_KEY]).map(drop).map_err(err)).await
}

async fn note(store: &Arc<Store>, key: &'static str, value: Option<String>) {
    let s = store.clone();
    if let Err(e) = blocking(move || set(&s, key, value.as_deref())).await {
        log::warn!("mobile snapshot: {e}");
    }
}

async fn run_pass<B: Bucket>(
    store: &Arc<Store>,
    bucket_for: impl FnOnce(Creds) -> B,
    page: &[PageFile],
    on_applied: &(dyn Fn(&Effects) + Send + Sync),
    inbox_only: bool,
) {
    RUNNING.store(true, Ordering::SeqCst);
    let _running = Running;
    let s = store.clone();
    let (creds_now, enabled) = match blocking(move || creds(&s)).await {
        Ok(Some(found)) => found,
        Ok(None) => return,
        Err(e) => return log::warn!("mobile snapshot: {e}"),
    };
    let bucket = bucket_for(creds_now);
    if !enabled {
        if let Err(e) = withdraw_token(store, &bucket).await {
            log::warn!("mobile snapshot: withdrawing the token: {e}");
            note(store, LAST_ERROR, Some(e)).await;
        }
        return;
    }
    if inbox_only {
        match take_inbox(store, &bucket, on_applied).await {
            // What just applied should show on the phone without waiting for the next full pass.
            Ok(n) if n > 0 => {}
            Ok(_) => return,
            Err(e) => {
                log::warn!("mobile inbox: {e}");
                return note(store, LAST_ERROR, Some(e)).await;
            }
        }
    }
    match publish(store, &bucket, page, on_applied).await {
        Ok(()) => {
            note(store, LAST_PUBLISH, Some(unix_now().to_string())).await;
            note(store, LAST_ERROR, None).await;
        }
        Err(e) => {
            log::warn!("mobile snapshot: {e}");
            note(store, LAST_ERROR, Some(e)).await;
        }
    }
}

/// Publishes on a schedule, and at once when `wake` is notified (a new token, new settings, the button).
pub async fn run_scheduler(store: Arc<Store>, page: Vec<PageFile>, on_applied: Box<dyn Fn(&Effects) + Send + Sync>, wake: Arc<Notify>) {
    let http = r2::client();
    let mut woken = tokio::select! {
        _ = tokio::time::sleep(FIRST_CHECK) => false,
        _ = wake.notified() => true,
    };
    loop {
        let s = store.clone();
        let last = blocking(move || get(&s, LAST_PUBLISH)).await.ok().flatten().and_then(|v| v.parse::<u64>().ok());
        let due = woken || last.is_none_or(|t| unix_now() >= t.saturating_add(PUBLISH_EVERY_SECS));
        let client = http.clone();
        run_pass(&store, |creds| R2Bucket { http: client, creds }, &page, on_applied.as_ref(), !due).await;
        woken = tokio::select! {
            _ = tokio::time::sleep(INBOX_EVERY) => false,
            _ = wake.notified() => true,
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::io::Read;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Memory {
        objects: Mutex<BTreeMap<String, Vec<u8>>>,
        puts: Mutex<Vec<String>>,
        fail_puts_of: Mutex<Option<String>>,
    }

    impl Memory {
        fn with(&self, key: &str, body: &str) {
            self.objects.lock().unwrap().insert(key.into(), body.as_bytes().to_vec());
        }
        fn keys(&self) -> Vec<String> {
            self.objects.lock().unwrap().keys().cloned().collect()
        }
        fn json(&self, key: &str) -> serde_json::Value {
            let objects = self.objects.lock().unwrap();
            let mut text = String::new();
            flate2::read::GzDecoder::new(&objects[key][..]).read_to_string(&mut text).unwrap();
            serde_json::from_str(&text).unwrap()
        }
        fn auth(&self) -> serde_json::Value {
            serde_json::from_slice(&self.objects.lock().unwrap()[AUTH_KEY]).unwrap()
        }
        fn take_puts(&self) -> Vec<String> {
            std::mem::take(&mut self.puts.lock().unwrap())
        }
    }

    impl Bucket for &Memory {
        async fn put(&self, key: &str, body: Vec<u8>) -> Result<(), String> {
            if self.fail_puts_of.lock().unwrap().as_deref() == Some(key) {
                return Err("no connection".into());
            }
            self.puts.lock().unwrap().push(key.into());
            self.objects.lock().unwrap().insert(key.into(), body);
            Ok(())
        }
        async fn get(&self, key: &str) -> Result<Vec<u8>, String> {
            self.objects.lock().unwrap().get(key).cloned().ok_or_else(|| format!("no {key}"))
        }
        async fn delete(&self, key: &str) -> Result<(), String> {
            self.objects.lock().unwrap().remove(key);
            Ok(())
        }
        async fn list(&self, prefix: &str) -> Result<Vec<String>, String> {
            Ok(self.keys().into_iter().filter(|k| k.starts_with(prefix)).collect())
        }
    }

    fn setup() -> (Arc<Store>, Memory, i64) {
        let store = Arc::new(Store::open_in_memory().unwrap());
        mobile::token(&store).unwrap();
        let id = store.upsert_pending("https://example.com/a", "https://example.com/a", "example.com").unwrap().0;
        (store, Memory::default(), id)
    }

    const PAGE: &[PageFile] = &[("index.html", b"<html>"), ("icon-256.png", b"png")];

    async fn pass(store: &Arc<Store>, bucket: &Memory) {
        publish(store, &bucket, PAGE, &|_| {}).await.unwrap();
    }

    #[tokio::test]
    async fn a_pass_leaves_what_the_worker_reads() {
        let (store, bucket, id) = setup();
        pass(&store, &bucket).await;
        let keys = bucket.keys();
        for key in ["auth.json", "index.json", "page/index.html", "page/icon-256.png"] {
            assert!(keys.contains(&key.to_string()), "{key} in {keys:?}");
        }
        assert_eq!(bucket.json(&format!("articles/{id}.json"))["article"]["id"], id);
        assert_eq!(bucket.json("index.json")["articles"][0]["id"], id);
        let objects = bucket.objects.lock().unwrap();
        assert_eq!(objects["page/icon-256.png"], b"png", "an image is not compressed");
        assert_eq!(objects["page/index.html"][..2], [0x1f, 0x8b]);
        let auth: serde_json::Value = serde_json::from_slice(&objects["auth.json"]).unwrap();
        assert_eq!(auth["token_hash"], sha256_hex(mobile::token(&store).unwrap()));
    }

    #[tokio::test]
    async fn only_what_changed_goes_up_and_read_state_is_the_lists_business() {
        let (store, bucket, id) = setup();
        pass(&store, &bucket).await;
        bucket.take_puts();
        pass(&store, &bucket).await;
        assert_eq!(bucket.take_puts(), ["index.json"]);
        store.set_read_status(id, true).unwrap();
        store.set_favorite(id, true).unwrap();
        pass(&store, &bucket).await;
        assert_eq!(bucket.take_puts(), ["index.json"], "the list carries it; thousands of bodies need not go up again");
        assert_eq!(bucket.json("index.json")["articles"][0]["read_status"], "read");
    }

    #[tokio::test]
    async fn a_new_token_replaces_the_old_one_in_the_next_pass() {
        let (store, bucket, _) = setup();
        pass(&store, &bucket).await;
        let new = mobile::regenerate_token(&store).unwrap();
        bucket.take_puts();
        pass(&store, &bucket).await;
        assert!(bucket.take_puts().contains(&"auth.json".to_string()));
        assert_eq!(bucket.auth()["token_hash"], sha256_hex(new));
    }

    #[tokio::test]
    async fn a_deleted_article_comes_down_after_the_list() {
        let (store, bucket, id) = setup();
        pass(&store, &bucket).await;
        store.delete_article(id).unwrap();
        pass(&store, &bucket).await;
        assert!(!bucket.keys().contains(&format!("articles/{id}.json")));
        assert_eq!(bucket.json("index.json")["articles"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn a_failed_pass_leaves_the_old_list_and_the_next_one_picks_up() {
        let (store, bucket, id) = setup();
        let other = store.upsert_pending("https://example.com/b", "https://example.com/b", "example.com").unwrap().0;
        *bucket.fail_puts_of.lock().unwrap() = Some(format!("articles/{id}.json"));
        assert!(publish(&store, &&bucket, PAGE, &|_| {}).await.is_err());
        assert!(!bucket.keys().contains(&"index.json".to_string()), "no list points at what is not there");
        *bucket.fail_puts_of.lock().unwrap() = None;
        bucket.take_puts();
        pass(&store, &bucket).await;
        let puts = bucket.take_puts();
        assert!(puts.contains(&format!("articles/{id}.json")));
        assert!(!puts.contains(&format!("articles/{other}.json")), "what got through stays through: {puts:?}");
    }

    #[tokio::test]
    async fn starting_over_uploads_everything_again() {
        let (store, bucket, id) = setup();
        pass(&store, &bucket).await;
        forget_published(&store).unwrap();
        bucket.take_puts();
        pass(&store, &bucket).await;
        assert!(bucket.take_puts().contains(&format!("articles/{id}.json")));
    }

    #[tokio::test]
    async fn the_inbox_applies_in_order_of_arrival_and_empties() {
        let (store, bucket, id) = setup();
        bucket.with("inbox/000000000000002-b.json", &format!(r#"{{"id":"b","op":{{"kind":"set_read","article_id":{id},"read":false}}}}"#));
        bucket.with("inbox/000000000000001-a.json", &format!(r#"{{"id":"a","op":{{"kind":"set_read","article_id":{id},"read":true}}}}"#));
        let told = Mutex::new(Vec::new());
        let applied = take_inbox(&store, &&bucket, &|e| told.lock().unwrap().push(e.article)).await.unwrap();
        assert_eq!(applied, 2);
        assert_eq!(*told.lock().unwrap(), [Some(id), Some(id)]);
        assert_eq!(store.article_row(id).unwrap().unwrap().read_status, "unread", "the later one wins");
        assert!(bucket.keys().iter().all(|k| !k.starts_with("inbox/")));
        pass(&store, &bucket).await;
        let applied: Vec<String> = serde_json::from_value(bucket.json("index.json")["applied_ops"].clone()).unwrap();
        assert!(applied.contains(&"a".to_string()) && applied.contains(&"b".to_string()));
    }

    #[tokio::test]
    async fn what_can_never_apply_leaves_the_inbox_and_is_remembered_until_the_reader_acts() {
        let (store, bucket, _) = setup();
        bucket.with("inbox/1-a.json", "not json");
        bucket.with("inbox/2-b.json", r#"{"id":"b","op":{"kind":"save_url","url":"javascript:x"}}"#);
        assert_eq!(take_inbox(&store, &&bucket, &|_| {}).await.unwrap(), 0);
        assert!(bucket.keys().iter().all(|k| !k.starts_with("inbox/")));
        assert!(status(&store).unwrap().last_rejected.unwrap().contains("mobile.badUrl"));
        clear_rejected(&store).unwrap();
        assert_eq!(status(&store).unwrap().last_rejected, None);
    }

    #[tokio::test]
    async fn an_operation_already_applied_directly_is_not_applied_again_from_the_inbox() {
        let (store, bucket, id) = setup();
        let body = format!(r#"{{"id":"same","op":{{"kind":"set_read","article_id":{id},"read":true}}}}"#);
        mobile::apply(&store, &serde_json::from_str(&body).unwrap()).unwrap();
        store.set_read_status(id, false).unwrap();
        bucket.with("inbox/1-same.json", &body);
        assert_eq!(take_inbox(&store, &&bucket, &|_| {}).await.unwrap(), 0);
        assert_eq!(store.article_row(id).unwrap().unwrap().read_status, "unread");
        assert!(bucket.keys().iter().all(|k| !k.starts_with("inbox/")));
    }

    fn settings(enabled: bool, bucket: &str, worker_url: &str) -> SnapshotSettings {
        SnapshotSettings {
            enabled,
            account_id: "0123456789abcdef0123456789abcdef".into(),
            bucket: bucket.into(),
            access_key_id: "AKID".into(),
            secret_access_key: Some("s3cret".into()),
            worker_url: worker_url.into(),
        }
    }

    async fn run(store: &Arc<Store>, bucket: &Memory, inbox_only: bool) {
        run_pass(store, |_| bucket, PAGE, &|_| {}, inbox_only).await;
    }

    const WORKER: &str = "https://m.example.workers.dev";

    #[tokio::test]
    async fn a_pass_records_how_it_went() {
        let (store, bucket, id) = setup();
        save(&store, &settings(true, "lattice-mobile", WORKER)).unwrap();
        *bucket.fail_puts_of.lock().unwrap() = Some(format!("articles/{id}.json"));
        run(&store, &bucket, false).await;
        let failed = status(&store).unwrap();
        assert_eq!(failed.last_error.as_deref(), Some("no connection"));
        assert_eq!(failed.last_publish, None, "no QR code for a snapshot that is not there");
        *bucket.fail_puts_of.lock().unwrap() = None;
        run(&store, &bucket, false).await;
        let done = status(&store).unwrap();
        assert_eq!(done.last_error, None);
        assert!(done.last_publish.is_some());
        assert!(!done.running);
    }

    #[tokio::test]
    async fn between_passes_only_the_inbox_is_read_and_an_operation_publishes_at_once() {
        let (store, bucket, id) = setup();
        save(&store, &settings(true, "lattice-mobile", WORKER)).unwrap();
        run(&store, &bucket, true).await;
        assert!(bucket.take_puts().is_empty(), "nothing to do");
        bucket.with("inbox/1-a.json", &format!(r#"{{"id":"a","op":{{"kind":"set_favorite","article_id":{id},"favorite":true}}}}"#));
        run(&store, &bucket, true).await;
        assert!(bucket.take_puts().contains(&"index.json".to_string()));
        assert_eq!(bucket.json("index.json")["applied_ops"][0], "a");
    }

    #[tokio::test]
    async fn turning_it_off_stops_the_worker_accepting_any_token() {
        let (store, bucket, _) = setup();
        save(&store, &settings(true, "lattice-mobile", WORKER)).unwrap();
        run(&store, &bucket, false).await;
        let old = mobile::token(&store).unwrap();
        assert_eq!(bucket.auth()["token_hash"], sha256_hex(&old));
        save(&store, &settings(false, "lattice-mobile", WORKER)).unwrap();
        mobile::regenerate_token(&store).unwrap();
        bucket.take_puts();
        run(&store, &bucket, true).await;
        assert_eq!(bucket.auth()["token_hash"], serde_json::Value::Null);
        assert_eq!(bucket.take_puts(), ["auth.json"]);
        run(&store, &bucket, true).await;
        assert!(bucket.take_puts().is_empty(), "once");
        save(&store, &settings(true, "lattice-mobile", WORKER)).unwrap();
        run(&store, &bucket, false).await;
        assert_eq!(bucket.auth()["token_hash"], sha256_hex(mobile::token(&store).unwrap()), "and back on");
    }

    #[tokio::test]
    async fn a_bucket_never_published_to_is_left_alone_when_off() {
        let (store, bucket, _) = setup();
        save(&store, &settings(false, "lattice-mobile", WORKER)).unwrap();
        run(&store, &bucket, true).await;
        assert!(bucket.keys().is_empty());
    }

    #[test]
    fn turning_it_on_needs_everything_and_a_new_bucket_starts_over() {
        let s = Store::open_in_memory().unwrap();
        assert!(save(&s, &settings(true, "lattice-mobile", "")).is_err());
        save(&s, &settings(true, "lattice-mobile", "https://m.example.workers.dev/")).unwrap();
        let got = status(&s).unwrap();
        assert!(got.enabled && got.has_secret);
        assert_eq!(got.worker_url, WORKER);
        assert!(creds(&s).unwrap().is_some_and(|(_, on)| on));
        s.conn().execute("INSERT INTO mobile_published (key, hash) VALUES ('x', 'y')", []).unwrap();
        set(&s, LAST_PUBLISH, Some("1")).unwrap();
        save(&s, &settings(true, "lattice-mobile", WORKER)).unwrap();
        let count = |s: &Store| s.conn().query_row("SELECT COUNT(*) FROM mobile_published", [], |r| r.get::<_, i64>(0)).unwrap();
        assert_eq!(count(&s), 1, "the same bucket keeps what it knows");
        assert_eq!(status(&s).unwrap().last_publish, Some(1), "the same bucket keeps it");
        save(&s, &settings(true, "another-bucket", WORKER)).unwrap();
        assert_eq!(count(&s), 0);
        assert_eq!(status(&s).unwrap().last_publish, None);
        save(&s, &settings(false, "another-bucket", WORKER)).unwrap();
        assert!(creds(&s).unwrap().is_some_and(|(_, on)| !on));
    }

    #[test]
    fn only_the_workers_origin_counts() {
        let s = Store::open_in_memory().unwrap();
        assert_eq!(worker_origin(&s).unwrap(), None);
        save(&s, &settings(false, "lattice-mobile", "https://M.example.workers.dev/")).unwrap();
        assert_eq!(worker_origin(&s).unwrap().as_deref(), Some(WORKER));
    }

    #[test]
    fn the_secret_stays_out_of_backups() {
        assert!(SECRET_KEY.starts_with(crate::store::SECRET_PREFIX));
    }

    /// Writes a snapshot to a folder, to look at the whole path by hand with the real Worker code:
    /// MOBILE_SNAPSHOT_DB=<a copy of a library> MOBILE_SNAPSHOT_OUT=<folder> cargo test -p lattice-core write_a_snapshot -- --ignored
    #[tokio::test]
    #[ignore = "needs a library; see above"]
    async fn write_a_snapshot_to_a_folder() {
        let store = Arc::new(Store::open(std::env::var("MOBILE_SNAPSHOT_DB").unwrap().as_ref()).unwrap());
        mobile::token(&store).unwrap();
        forget_published(&store).unwrap();
        let bucket = Memory::default();
        publish(&store, &&bucket, &[], &|_| {}).await.unwrap();
        let out = std::path::PathBuf::from(std::env::var("MOBILE_SNAPSHOT_OUT").unwrap());
        for (key, body) in bucket.objects.lock().unwrap().iter() {
            let path = out.join(key);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, body).unwrap();
        }
    }
}
