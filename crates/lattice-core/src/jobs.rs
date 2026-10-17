//! In-process job runners. The queue lives in SQLite, so jobs survive crashes and restarts.
//! Each runner drains a subset of job types serially: LLM jobs (rate-limited CLIs), local jobs
//! (embeddings) and network jobs (bulk-import fetches, several runners) run separately so a long
//! translation queue never delays indexing or importing.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Notify;

use crate::embed::{self, EmbeddingProvider};
use crate::fetch::HttpClient;
use crate::ingest;
use crate::llm::LlmProvider;
use crate::store::{JobRow, Store};
use crate::{classify, render, summarize, translate};

pub const LLM_JOBS: &[&str] = &[translate::JOB_TYPE, summarize::JOB_TYPE, classify::JOB_TYPE];
pub const LOCAL_JOBS: &[&str] = &[embed::JOB_TYPE];
pub const NET_JOBS: &[&str] = &[ingest::JOB_TYPE];

/// Upper bound on how long a backed-off job waits past its `next_run_at`.
const IDLE_POLL: Duration = Duration::from_secs(30);

pub struct Providers<L, E> {
    pub llm: L,
    pub embedder: E,
    pub http: HttpClient,
}

/// Call `store.recover_running_jobs()` once before starting runners, not per runner.
pub async fn run_worker<L: LlmProvider, E: EmbeddingProvider>(
    store: Arc<Store>,
    providers: Arc<Providers<L, E>>,
    types: &'static [&'static str],
    wake: Arc<Notify>,
    on_change: impl Fn(i64) + Send + Sync + 'static,
) {
    loop {
        match run_next(&store, &providers, types, &on_change).await {
            Ok(true) => continue,
            Ok(false) => {}
            Err(e) => log::error!("job runner: {e}"),
        }
        tokio::select! {
            _ = wake.notified() => {}
            _ = tokio::time::sleep(IDLE_POLL) => {}
        }
    }
}

/// Claims and runs one ready job of `types`. Returns whether a job ran.
pub async fn run_next<L: LlmProvider, E: EmbeddingProvider>(
    store: &Store,
    providers: &Providers<L, E>,
    types: &[&str],
    on_change: &(dyn Fn(i64) + Send + Sync),
) -> Result<bool, String> {
    let Some(job) = store.claim_next_job(types).map_err(|e| e.to_string())? else {
        return Ok(false);
    };
    let article_id = job.article_id.unwrap_or_default();
    on_change(article_id);
    let result = run_job(store, providers, &job, &|| on_change(article_id)).await;
    if let Err(e) = &result {
        log::warn!("job {} ({}) article {article_id} attempt {} failed: {e}", job.id, job.job_type, job.attempt_count);
    }
    store.finish_job(job.id, result.err().as_deref()).map_err(|e| e.to_string())?;
    on_change(article_id);
    Ok(true)
}

async fn run_job<L: LlmProvider, E: EmbeddingProvider>(
    store: &Store,
    p: &Providers<L, E>,
    job: &JobRow,
    progress: &(dyn Fn() + Send + Sync),
) -> Result<(), String> {
    let params: serde_json::Value = job.params.as_deref().map(serde_json::from_str).transpose().map_err(|e| e.to_string())?.unwrap_or_default();
    let article_id = job.article_id.ok_or("job has no article")?;
    match job.job_type.as_str() {
        translate::JOB_TYPE => {
            let target = params["target_language"].as_str().unwrap_or(translate::TARGET_LANGUAGE);
            translate::run(store, &p.llm, article_id, target, progress).await
        }
        summarize::JOB_TYPE => summarize::run(store, &p.llm, article_id).await,
        classify::JOB_TYPE => classify::run(store, &p.llm, article_id).await,
        embed::JOB_TYPE => embed::run(store, &p.embedder, article_id).await,
        ingest::JOB_TYPE => {
            // Fetch failures are recorded on the article (visible, retryable); only storage errors fail the job.
            let id = ingest::process(store, &p.http, article_id).await?;
            classify::enqueue_if_auto(store, id)?;
            render::enqueue_if_auto(store, id)?;
            embed::enqueue(store, id, p.embedder.model_id())
        }
        other => Err(format!("unknown job type: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embed::Purpose;
    use crate::fetch::Fetched;
    use crate::ingest::store_fetched;
    use crate::segments::tests::Fake;

    struct NoEmbed;
    impl EmbeddingProvider for NoEmbed {
        fn model_id(&self) -> &str {
            "none"
        }
        async fn embed(&self, _: Vec<String>, _: Purpose) -> Result<Vec<Vec<f32>>, String> {
            Err("unused".into())
        }
    }

    fn with(llm: Fake) -> Providers<Fake, NoEmbed> {
        Providers { llm, embedder: NoEmbed, http: crate::fetch::client() }
    }

    fn setup() -> (Store, i64) {
        let s = Store::open_in_memory().unwrap();
        let (id, _) = s.upsert_pending("https://example.com/a", "https://example.com/a", "example.com").unwrap();
        let html = "<html><body><article><h2>Intro</h2>            <p>Snapshot isolation permits <code>write skew</code>, which serializable snapshot isolation prevents at commit time.</p>            <p>スナップショット分離について日本語で書かれた段落です。</p>            <pre><code>SELECT 1;</code></pre></article></body></html>";
        let f = Fetched { final_url: "https://example.com/a".into(), status: 200, content_type: None, html: html.into() };
        store_fetched(&s, id, &f).unwrap();
        (s, id)
    }

    #[tokio::test]
    async fn translates_prose_blocks_and_is_idempotent() {
        let (s, id) = setup();
        translate::enqueue(&s, id, "ja").unwrap();
        let p = with(Fake::new());
        assert!(run_next(&s, &p, LLM_JOBS, &|_| {}).await.unwrap());
        assert!(!run_next(&s, &p, LLM_JOBS, &|_| {}).await.unwrap(), "queue drained");

        let sent: Vec<serde_json::Value> = serde_json::from_str(&p.llm.calls.lock().unwrap()[0]).unwrap();
        assert_eq!(sent.len(), 2, "code and Japanese blocks are not sent");
        assert!(sent[1]["html"].as_str().unwrap().contains("<code>write skew</code>"), "{sent:?}");

        let v = s.get_article(id, "ja").unwrap().unwrap();
        assert_eq!(v.blocks[0].translation.as_deref(), Some("INTRO"));
        assert!(v.blocks[1].translation.as_deref().unwrap().starts_with("SNAPSHOT ISOLATION PERMITS WRITE SKEW"));
        assert_eq!(v.blocks[3].translation, None);
        assert_eq!(v.jobs[0].status, "succeeded");

        // Re-enqueue: nothing left to translate, provider is not called again.
        translate::enqueue(&s, id, "ja").unwrap();
        run_next(&s, &p, LLM_JOBS, &|_| {}).await.unwrap();
        assert_eq!(p.llm.calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn failure_backs_off_and_manual_retry_resumes() {
        let (s, id) = setup();
        translate::enqueue(&s, id, "ja").unwrap();
        run_next(&s, &with(Fake { fail: true, ..Fake::new() }), LLM_JOBS, &|_| {}).await.unwrap();
        let job = &s.get_article(id, "ja").unwrap().unwrap().jobs[0];
        assert_eq!((job.status.as_str(), job.attempt_count), ("pending", 1));
        assert!(job.next_run_at.is_some() && job.last_error.as_deref() == Some("provider failed: usage limit reached"));
        assert!(!run_next(&s, &with(Fake::new()), LLM_JOBS, &|_| {}).await.unwrap(), "not ready until backoff elapses");

        translate::enqueue(&s, id, "ja").unwrap();
        run_next(&s, &with(Fake::new()), LLM_JOBS, &|_| {}).await.unwrap();
        assert_eq!(s.get_article(id, "ja").unwrap().unwrap().jobs[0].status, "succeeded");
    }

    #[tokio::test]
    async fn summarizes_and_marks_stale_after_content_change() {
        let (s, id) = setup();
        crate::summarize::enqueue(&s, id).unwrap();
        let p = with(Fake::new());
        run_next(&s, &p, LLM_JOBS, &|_| {}).await.unwrap();
        let input = p.llm.calls.lock().unwrap()[0].clone();
        assert!(input.contains("## Intro") && input.contains("write skew") && !input.contains("SELECT 1"), "{input}");
        let v = s.get_article(id, "ja").unwrap().unwrap();
        let sum = v.summary.unwrap();
        assert_eq!((sum.text.as_str(), sum.stale), ("要約です。\n\n・要点", false));
        s.exec_for_test(&format!("UPDATE articles SET content_hash = 'changed' WHERE id = {id}"));
        assert!(s.get_article(id, "ja").unwrap().unwrap().summary.unwrap().stale);
    }

    #[test]
    fn recovers_jobs_left_running() {
        let (s, id) = setup();
        translate::enqueue(&s, id, "ja").unwrap();
        s.claim_next_job(LLM_JOBS).unwrap().unwrap();
        assert_eq!(s.recover_running_jobs().unwrap(), 1);
        assert!(s.claim_next_job(LLM_JOBS).unwrap().is_some());
    }
}
