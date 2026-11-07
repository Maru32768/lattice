//! The reproductions of docs/audits/reliability-audit.md, kept as regression tests now that each is
//! fixed: failure paths across a crash, a second process or a provider outage, seen from the outside.
#![allow(clippy::unwrap_used, reason = "a failed step fails the test")]

use std::path::{Path, PathBuf};
use std::time::Duration;

use lattice_core::fetch::{self, Fetched};
use lattice_core::ingest::store_fetched;
use lattice_core::jobs::{self, Providers};
use lattice_core::llm::{Completion, LlmError, LlmProvider};
use lattice_core::store::Store;
use lattice_core::{embed, groups, job_status, summarize};
use serde_json::{Value, json};

/// A temporary data folder, removed when dropped.
struct Dir(PathBuf);

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

impl std::ops::Deref for Dir {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

fn data_dir(name: &str) -> Dir {
    let dir = std::env::temp_dir().join(format!("lattice-audit-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    Dir(dir)
}

const PROSE: &str = "<p>Snapshot isolation permits write skew, which serializable snapshot isolation prevents at commit time. A transaction reads from a snapshot taken when it starts and writes its changes at commit, so two transactions can each read what the other is about to change, and each still commits without seeing a conflict at all.</p>";

fn page(url: &str, head: &str) -> Fetched {
    Fetched { final_url: url.into(), status: 200, content_type: None, html: format!("<html><head>{head}</head><body><article>{PROSE}</article></body></html>") }
}

/// An article with extracted text, as after a successful fetch.
fn saved(s: &Store, url: &str) -> i64 {
    let (id, _) = s.upsert_pending(url, url, "example.com").unwrap();
    store_fetched(s, id, &page(url, "")).unwrap()
}

fn job(db: &Path, id: i64) -> (String, i64) {
    let c = rusqlite::Connection::open(db).unwrap();
    c.query_row("SELECT status, attempt_count FROM processing_jobs WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
}

/// Ages every job's heartbeat by two minutes, as that long without a beat would.
fn lapse_heartbeats(db: &Path) {
    let c = rusqlite::Connection::open(db).unwrap();
    c.execute("UPDATE processing_jobs SET heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 minutes')", []).unwrap();
}

struct NoEmbed;
impl embed::EmbeddingProvider for NoEmbed {
    fn model_id(&self) -> &str {
        "none"
    }
    async fn embed(&self, _: Vec<String>, _: embed::Purpose) -> Result<Vec<Vec<f32>>, String> {
        Err("unused".into())
    }
}

/// Answers every summary, after running `during` (to change the world while the job is in flight).
struct Summarizer<F: Fn() + Send + Sync + 'static>(F);
impl<F: Fn() + Send + Sync + 'static> LlmProvider for Summarizer<F> {
    fn name(&self) -> &str {
        "audit"
    }
    async fn complete_json(&self, _: &str, _: &str, _: &Value) -> Result<Completion, LlmError> {
        (self.0)();
        Ok(Completion { value: json!({ "summary": "要約。", "key_points": ["要点"] }), model: None, provider: "audit".into() })
    }
}

/// A job whose run takes the process down never reaches `finish_job`, so recovery has to count it
/// (`recover_abandoned_jobs`), or one such job is a crash at every launch.
#[test]
fn a_job_that_takes_the_process_down_stops_being_retried() {
    let dir = data_dir("poison");
    let db = dir.join("lattice.db");
    let job_id = {
        let s = Store::open(&db).unwrap();
        let id = saved(&s, "https://example.com/poison");
        summarize::enqueue(&s, id).unwrap();
        s.claim_next_job(&[summarize::JOB_TYPE]).unwrap().unwrap().id
    };
    // The process dies mid-job (`finish_job` never runs), and the app runs again past the backoff, eight times.
    for _ in 0..8 {
        let s = Store::open(&db).unwrap();
        lapse_heartbeats(&db);
        s.recover_abandoned_jobs().unwrap();
        rusqlite::Connection::open(&db).unwrap().execute("UPDATE processing_jobs SET next_run_at = NULL", []).unwrap();
        if s.claim_next_job(&[summarize::JOB_TYPE]).unwrap().is_none() {
            break;
        }
    }
    let (status, attempts) = job(&db, job_id);
    assert_eq!(status, "failed", "still claimed at every start after {attempts} attempts");
}

/// If `finish_job` cannot write (another process holds the write lock for the 3 x 5 s busy
/// timeout), the job is left `running`, and the Jobs view's retry and enqueue both skip running
/// jobs (for fetches, the host stays blocked for every other article). Its heartbeat stops with the
/// failed finish, so within about a minute the next `keep_alive` round puts it back in the queue,
/// without a restart. Takes about 20 s.
#[tokio::test]
async fn a_job_whose_finish_cannot_be_written_does_not_stay_running() {
    let dir = data_dir("stuck");
    let db = dir.join("lattice.db");
    let s = Store::open(&db).unwrap();
    let id = saved(&s, "https://example.com/stuck");
    summarize::enqueue(&s, id).unwrap();
    let lock_db = db.clone();
    let (released_tx, released) = std::sync::mpsc::channel();
    // A CLI/MCP write transaction that starts while the model answers and outlasts the summary's
    // write (5 s busy timeout) and the three `finish_job` tries (3 x 5 s + 2 x 250 ms).
    let llm = Summarizer(move || {
        let (db, released_tx) = (lock_db.clone(), released_tx.clone());
        let (locked_tx, locked) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let c = rusqlite::Connection::open(&db).unwrap();
            c.execute_batch("BEGIN IMMEDIATE").unwrap();
            locked_tx.send(()).unwrap();
            std::thread::sleep(Duration::from_secs(22));
            c.execute_batch("COMMIT").unwrap();
            released_tx.send(()).unwrap();
        });
        locked.recv().unwrap();
    });
    let p = Providers { llm, embedder: NoEmbed, http: fetch::client() };
    let ran = jobs::run_next(&s, &p, &[summarize::JOB_TYPE], &|_| {}).await;
    assert!(ran.is_err(), "finish_job gave up: {ran:?}");
    released.recv().unwrap();

    let job_id = s.get_article(id, "ja").unwrap().unwrap().jobs[0].id;
    lapse_heartbeats(&db);
    assert_eq!(s.recover_abandoned_jobs().unwrap(), 1, "the job stays running until restart");
    assert_eq!(job(&db, job_id).0, "pending");
    assert!(job_status::retry(&s, job_id).unwrap().is_some(), "the Jobs view's retry runs it again");
}

/// A fetch whose canonical URL names an article already saved, with the same text, drops the new row
/// in favour of it (`save_snapshot`). The row can be one whose earlier fetch failed and that the user
/// has since tagged, starred, noted and put in a group: all of that moves to the kept article.
#[test]
fn merging_a_refetched_article_into_an_existing_one_keeps_the_users_data() {
    let s = Store::open_in_memory().unwrap();
    let kept = saved(&s, "https://example.com/post");
    let (failed, _) = s.upsert_pending("https://mirror.example.net/post", "https://mirror.example.net/post", "mirror.example.net").unwrap();
    s.record_fetch_failure(failed, "fetch.timeout").unwrap();
    s.add_tag(failed, "to-read").unwrap();
    s.set_favorite(failed, true).unwrap();
    s.set_note(failed, "the part about write skew").unwrap();
    let group = groups::create(&s, "thesis").unwrap();
    groups::add(&s, group, &[failed]).unwrap();

    // Retry: the page now loads and declares the saved article as canonical.
    let survivor = store_fetched(&s, failed, &page("https://mirror.example.net/post", r#"<link rel="canonical" href="https://example.com/post">"#)).unwrap();
    assert_eq!(survivor, kept, "merged into the saved article");
    assert!(s.article_row(failed).unwrap().is_none(), "the retried row is deleted");

    let v = s.get_article(kept, "ja").unwrap().unwrap();
    let in_group = groups::list(&s).unwrap().iter().find(|g| g.id == group).unwrap().count;
    assert_eq!(
        (v.article.tags.clone(), v.article.favorite, v.note.clone(), in_group),
        (vec!["to-read".to_string()], true, Some("the part about write skew".to_string()), 1),
        "the user's tag, star, note and group membership survive the merge"
    );
}

const AS_APP: &str = "LATTICE_AUDIT_AS_APP";

/// `kill_on_drop(true)` is a destructor. Tauri leaves through `std::process::exit` (tauri app.rs `run`),
/// which runs none, and Windows does not end a process's children with it: without
/// `end_with_this_process`, a CLI call in flight when the app quits keeps running.
#[cfg(windows)]
#[test]
fn a_cli_call_in_flight_does_not_outlive_the_app() {
    if std::env::var_os(AS_APP).is_some() {
        // The app: a job waits on its CLI child, then the user quits.
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let child = tokio::process::Command::new("ping")
                .args(["-n", "30", "127.0.0.1"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            lattice_core::llm::end_with_this_process(&child);
            println!("child-pid {}", child.id().unwrap());
            std::process::exit(0);
        });
    }
    use std::io::BufRead;
    let me = std::env::current_exe().unwrap();
    let mut app = std::process::Command::new(me)
        .args(["--exact", "a_cli_call_in_flight_does_not_outlive_the_app", "--nocapture"])
        .env(AS_APP, "1")
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    // Not `output()`: the child inherits the app's stdout handle, so the pipe stays open as long as it runs.
    let lines = std::io::BufReader::new(app.stdout.take().unwrap()).lines();
    let pid = lines.map_while(Result::ok).find_map(|l| l.strip_prefix("child-pid ").map(str::to_string)).unwrap();
    assert!(app.wait().unwrap().success(), "the app exited");
    std::thread::sleep(Duration::from_millis(500));
    let listed = std::process::Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH"]).output().unwrap();
    let alive = String::from_utf8_lossy(&listed.stdout).contains(&pid);
    let _ = std::process::Command::new("taskkill").args(["/PID", &pid, "/F"]).output();
    assert!(!alive, "the child (pid {pid}) is still running after its parent exited");
}

/// Translates every snippet, except that any call containing POISON fails a moment later (a block
/// the model cannot handle: over its output limit, refused, an HTTP 400).
struct Translator {
    calls: std::sync::Mutex<Vec<String>>,
}
impl LlmProvider for Translator {
    fn name(&self) -> &str {
        "audit"
    }
    async fn complete_json(&self, _: &str, input: &str, _: &Value) -> Result<Completion, LlmError> {
        self.calls.lock().unwrap().push(input.to_string());
        if input.contains("POISON") {
            tokio::time::sleep(Duration::from_millis(100)).await;
            return Err(LlmError::Malformed("max_tokens".into()));
        }
        let items: Vec<Value> = serde_json::from_str(input).unwrap();
        let blocks: Vec<Value> = items.iter().map(|it| json!({"i": it["i"], "sentences": [{"source": it["html"], "translation": "訳"}]})).collect();
        Ok(Completion { value: json!({ "blocks": blocks }), model: None, provider: "audit".into() })
    }
}

/// `translate::run` saves batches in article order (`buffered`). A batch whose call and retries all
/// failed must not drop the ones already answered behind it: they would be sent again (and billed
/// again) on each of the job's five attempts, and a block that always fails would keep the rest of
/// the article from ever being saved.
#[tokio::test]
async fn translations_already_returned_are_saved_when_an_earlier_batch_fails() {
    use lattice_core::segments::Target;
    use lattice_core::translate;
    let s = Store::open_in_memory().unwrap();
    // One paragraph over the 6000-character batch limit, alone in the first batch, then 24 more.
    let long = format!("<p>POISON {}</p>", "A long sentence about write skew and snapshots. ".repeat(140));
    let rest: String = (0..24).map(|n| format!("<p>Paragraph {n} explains how serializable snapshot isolation detects write skew at commit.</p>")).collect();
    let html = format!("<html><body><article>{long}{rest}</article></body></html>");
    let (id, _) = s.upsert_pending("https://example.com/long", "https://example.com/long", "example.com").unwrap();
    store_fetched(&s, id, &Fetched { final_url: "https://example.com/long".into(), status: 200, content_type: None, html }).unwrap();
    translate::set_parallel(&s, 3).unwrap();

    let p = Translator { calls: std::sync::Mutex::new(Vec::new()) };
    let result = translate::run(&s, &p, id, &Target::default(), None, &|| {}).await;
    let answered = p.calls.lock().unwrap().iter().filter(|c| !c.contains("POISON")).count();
    let saved = s.translated_count(id, "ja", &["paragraph"]).unwrap();
    assert!(result.is_err(), "the poisoned batch fails the job");
    assert!(answered > 0, "the batches after it were sent");
    assert!(saved >= 24, "{answered} answered calls, {saved} of 24 paragraphs saved");
}

fn article_page(url: &str, canonical: &str, text: &str) -> Fetched {
    let head = format!(r#"<link rel="canonical" href="{canonical}">"#);
    Fetched {
        final_url: url.into(),
        status: 200,
        content_type: None,
        html: format!("<html><head>{head}</head><body><article><p>{text}</p></article></body></html>"),
    }
}

/// The merge must not believe any canonical URL. On a site that declares its home page canonical on
/// every page (a common misconfiguration, and the default of many single-page-app templates), each
/// article saved after the first would be deleted and resolve to the first.
#[test]
fn articles_that_share_a_bogus_canonical_url_are_not_merged() {
    use lattice_core::store::ArticleFilter;
    let s = Store::open_in_memory().unwrap();
    for (n, topic) in [(1, "write skew under snapshot isolation"), (2, "how a B-tree page splits when it fills up")] {
        let url = format!("https://blog.example.com/posts/{n}");
        let (id, _) = s.upsert_pending(&url, &url, "blog.example.com").unwrap();
        let text = format!("This post explains {topic} with a worked example and a short benchmark. ").repeat(6);
        store_fetched(&s, id, &article_page(&url, "https://blog.example.com/", &text)).unwrap();
    }
    let titles: Vec<String> = s.list_articles(&ArticleFilter::All).unwrap().into_iter().map(|a| a.original_url).collect();
    assert_eq!(titles.len(), 2, "two different posts saved, the library has {titles:?}");
}

/// A job queued earlier (a bulk import or feed backlog, serialized per host) that runs after the user
/// saved the page from the in-app browser must not replace that save: here the server would refuse,
/// and a good article would turn "failed".
#[tokio::test]
async fn a_queued_fetch_does_not_undo_a_newer_save() {
    use lattice_core::ingest;
    let s = Store::open_in_memory().unwrap();
    // 127.0.0.1 is refused at once by the default network policy: the "server" answers with an error.
    let url = "http://127.0.0.1:9/post".to_string();
    ingest::enqueue_urls(&s, std::slice::from_ref(&url)).unwrap();
    let rendered = format!("<html><body><article>{}</article></body></html>", PROSE.repeat(4));
    let id = ingest::save_rendered(&s, &url, rendered).unwrap();
    assert_eq!(s.article_row(id).unwrap().unwrap().fetch_status, "ok", "saved from the browser");

    let p = Providers { llm: Summarizer(|| {}), embedder: NoEmbed, http: fetch::client() };
    assert!(jobs::run_next(&s, &p, jobs::NET_JOBS, &|_| {}).await.unwrap(), "the queued fetch ran");
    let a = s.article_row(id).unwrap().unwrap();
    assert_eq!((a.fetch_status.as_str(), a.extraction_status.as_str()), ("ok", "ok"), "last error: {:?}", a.last_error);
}

/// `backup_local` copies the database, API keys included, and strips them in a second step. If that
/// step fails (here a trigger makes the DELETE fail; a full disk during the scrubbing VACUUM does the
/// same), no copy may stay: it would hold the keys, and count as one of the generations to keep.
#[test]
fn a_failed_backup_leaves_no_copy_with_api_keys() {
    use lattice_core::backup;
    let dir = data_dir("backup");
    let db = dir.join("lattice.db");
    {
        let s = Store::open(&db).unwrap();
        s.set_setting("secret.openai_api_key", Some("sk-audit")).unwrap();
    }
    let c = rusqlite::Connection::open(&db).unwrap();
    c.execute_batch("CREATE TRIGGER audit_scrub_fails BEFORE DELETE ON settings BEGIN SELECT RAISE(ABORT, 'disk full'); END;").unwrap();
    drop(c);

    let backups = dir.join("backups");
    assert!(backup::backup_local(&db, &backups, 12, 30).is_err(), "the backup reports failure");
    let left: Vec<_> = std::fs::read_dir(&backups).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert!(left.is_empty(), "{left:?} left behind");
}

/// When the batch call fails, `translate_snippets` retries the batch's snippets alone. A provider that
/// is down or rate-limited must not get 1 + N calls per batch (13 for a full batch), each walking the
/// whole fallback chain.
#[tokio::test]
async fn a_provider_outage_is_not_multiplied_by_the_batch_size() {
    use lattice_core::segments::{Target, translate_snippets};
    struct Down(std::sync::atomic::AtomicUsize);
    impl LlmProvider for Down {
        fn name(&self) -> &str {
            "down"
        }
        async fn complete_json(&self, _: &str, _: &str, _: &Value) -> Result<Completion, LlmError> {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Err(LlmError::Unavailable("rate limited".into()))
        }
    }
    let p = Down(Default::default());
    let snippets: Vec<String> = (0..12).map(|n| format!("Paragraph {n} on write skew.")).collect();
    let t = translate_snippets(&p, &snippets, &Target::default()).await;
    let calls = p.0.load(std::sync::atomic::Ordering::SeqCst);
    assert!(t.error.is_some());
    assert!(calls <= 2, "{calls} calls for one batch of {} while the provider is down", snippets.len());
}

/// Recovery must not treat every `running` job as left by a dead process: an app start while
/// `lattice-cli save --run` works (or a second launch, before the single-instance guard) would take
/// over jobs another live process is running, and both would pay for them.
#[tokio::test]
async fn a_second_process_does_not_rerun_a_job_another_one_is_running() {
    let dir = data_dir("instances");
    let db = dir.join("lattice.db");
    let first = Store::open(&db).unwrap();
    let id = saved(&first, "https://example.com/twice");
    summarize::enqueue(&first, id).unwrap();
    let running = first.claim_next_job(&[summarize::JOB_TYPE]).unwrap().unwrap();

    // The second instance starts while the first one waits for the model.
    let second = Store::open(&db).unwrap();
    second.recover_abandoned_jobs().unwrap();
    let taken = second.claim_next_job(&[summarize::JOB_TYPE]).unwrap();
    assert_eq!(taken.map(|j| j.id), None, "job {} is claimed a second time while the first process runs it", running.id);
}
