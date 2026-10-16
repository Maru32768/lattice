//! Single in-process job runner. The queue lives in SQLite, so jobs survive crashes and
//! restarts; the runner just drains it serially (local CLIs are rate-limited anyway).

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Notify;

use crate::llm::LlmProvider;
use crate::store::{JobRow, Store};
use crate::translate;

/// Upper bound on how long a backed-off job waits past its `next_run_at`.
const IDLE_POLL: Duration = Duration::from_secs(30);

pub async fn run_worker<P: LlmProvider>(
    store: Arc<Store>,
    provider: P,
    wake: Arc<Notify>,
    on_change: impl Fn(i64) + Send + Sync + 'static,
) {
    if let Err(e) = store.recover_running_jobs() {
        eprintln!("job recovery failed: {e}");
    }
    loop {
        match run_next(&store, &provider, &on_change).await {
            Ok(true) => continue,
            Ok(false) => {}
            Err(e) => eprintln!("job runner: {e}"),
        }
        tokio::select! {
            _ = wake.notified() => {}
            _ = tokio::time::sleep(IDLE_POLL) => {}
        }
    }
}

/// Claims and runs one ready job. Returns whether a job ran.
pub async fn run_next<P: LlmProvider>(store: &Store, provider: &P, on_change: &(dyn Fn(i64) + Send + Sync)) -> Result<bool, String> {
    let Some(job) = store.claim_next_job().map_err(|e| e.to_string())? else {
        return Ok(false);
    };
    let article_id = job.article_id.unwrap_or_default();
    on_change(article_id);
    let result = run_job(store, provider, &job, &|| on_change(article_id)).await;
    if let Err(e) = &result {
        eprintln!("job {} ({}) article {article_id} attempt {} failed: {e}", job.id, job.job_type, job.attempt_count);
    }
    store.finish_job(job.id, result.err().as_deref()).map_err(|e| e.to_string())?;
    on_change(article_id);
    Ok(true)
}

async fn run_job<P: LlmProvider>(store: &Store, provider: &P, job: &JobRow, progress: &(dyn Fn() + Send + Sync)) -> Result<(), String> {
    let params: serde_json::Value = job.params.as_deref().map(serde_json::from_str).transpose().map_err(|e| e.to_string())?.unwrap_or_default();
    let article_id = job.article_id.ok_or("job has no article")?;
    match job.job_type.as_str() {
        translate::JOB_TYPE => {
            let target = params["target_language"].as_str().unwrap_or(translate::TARGET_LANGUAGE);
            translate::run(store, provider, article_id, target, progress).await
        }
        other => Err(format!("unknown job type: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::fetch::Fetched;
    use crate::ingest::store_fetched;
    use crate::llm::{Item, LlmError, Output};

    /// Uppercases text; drops ids listed in `drop`; fails when `fail` is set.
    struct Fake {
        fail: bool,
        drop: Vec<i64>,
        calls: Mutex<Vec<Vec<Item>>>,
    }

    impl LlmProvider for Fake {
        fn name(&self) -> &str {
            "fake"
        }
        async fn translate(&self, items: &[Item], _: &str) -> Result<Output, LlmError> {
            self.calls.lock().unwrap().push(items.to_vec());
            if self.fail {
                return Err(LlmError::Failed("usage limit reached".into()));
            }
            let items = items
                .iter()
                .filter(|i| !self.drop.contains(&i.id))
                .map(|i| Item { id: i.id, text: i.text.to_uppercase() })
                .chain([Item { id: 999_999, text: "injected".into() }])
                .collect();
            Ok(Output { items, model: Some("fake-1".into()) })
        }
    }

    fn fake(fail: bool, drop: Vec<i64>) -> Fake {
        Fake { fail, drop, calls: Mutex::new(Vec::new()) }
    }

    fn setup() -> (Store, i64) {
        let s = Store::open_in_memory().unwrap();
        let (id, _) = s.upsert_pending("https://example.com/a", "https://example.com/a", "example.com").unwrap();
        let html = "<html><body><article><h2>Intro</h2>\
            <p>Snapshot isolation permits <code>write skew</code>, which serializable snapshot isolation prevents at commit time.</p>\
            <pre><code>SELECT 1;</code></pre></article></body></html>";
        let f = Fetched { final_url: "https://example.com/a".into(), status: 200, content_type: None, html: html.into() };
        store_fetched(&s, id, &f).unwrap();
        (s, id)
    }

    #[tokio::test]
    async fn translates_prose_blocks_and_is_idempotent() {
        let (s, id) = setup();
        translate::enqueue(&s, id, "ja").unwrap();
        let p = fake(false, vec![]);
        assert!(run_next(&s, &p, &|_| {}).await.unwrap());
        assert!(!run_next(&s, &p, &|_| {}).await.unwrap(), "queue drained");

        let sent = p.calls.lock().unwrap()[0].clone();
        assert_eq!(sent.len(), 2, "code block is not sent");
        assert!(sent[1].text.contains("`write skew`"), "inline code is backticked: {}", sent[1].text);

        let v = s.get_article(id, "ja").unwrap().unwrap();
        assert_eq!(v.blocks[0].translation.as_deref(), Some("INTRO"));
        assert_eq!(v.blocks[2].translation, None);
        assert_eq!(v.jobs[0].status, "succeeded");

        // Re-enqueue: nothing left to translate, provider is not called again.
        translate::enqueue(&s, id, "ja").unwrap();
        run_next(&s, &p, &|_| {}).await.unwrap();
        assert_eq!(p.calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn failure_backs_off_and_partial_output_retries_only_missing() {
        let (s, id) = setup();
        translate::enqueue(&s, id, "ja").unwrap();
        run_next(&s, &fake(true, vec![]), &|_| {}).await.unwrap();
        let job = &s.get_article(id, "ja").unwrap().unwrap().jobs[0];
        assert_eq!((job.status.as_str(), job.attempt_count), ("pending", 1));
        assert!(job.next_run_at.is_some() && job.last_error.as_deref() == Some("provider failed: usage limit reached"));
        assert!(!run_next(&s, &fake(false, vec![]), &|_| {}).await.unwrap(), "not ready until backoff elapses");

        // Manual retry resets the backoff; provider drops the heading.
        translate::enqueue(&s, id, "ja").unwrap();
        let heading = s.get_article(id, "ja").unwrap().unwrap().blocks[0].id;
        run_next(&s, &fake(false, vec![heading]), &|_| {}).await.unwrap();
        let v = s.get_article(id, "ja").unwrap().unwrap();
        assert_eq!(v.jobs[0].status, "pending");
        assert!(v.blocks[1].translation.is_some() && v.blocks[0].translation.is_none());

        translate::enqueue(&s, id, "ja").unwrap();
        let p = fake(false, vec![]);
        run_next(&s, &p, &|_| {}).await.unwrap();
        assert_eq!(p.calls.lock().unwrap()[0].iter().map(|i| i.id).collect::<Vec<_>>(), [heading]);
        assert_eq!(s.get_article(id, "ja").unwrap().unwrap().jobs[0].status, "succeeded");
    }

    #[test]
    fn recovers_jobs_left_running() {
        let (s, id) = setup();
        translate::enqueue(&s, id, "ja").unwrap();
        s.claim_next_job().unwrap().unwrap();
        assert_eq!(s.recover_running_jobs().unwrap(), 1);
        assert!(s.claim_next_job().unwrap().is_some());
    }
}
