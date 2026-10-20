//! Processing-jobs view (§4.6 re-runnable jobs, §25 observability): counts per type and state,
//! the jobs that failed or are backing off, and manual retry / cancel.

use rusqlite::{OptionalExtension, params};
use serde::Serialize;

use crate::store::Store;

const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
/// Failed jobs and pending ones waiting out a backoff (`next_run_at` in the future).
const ISSUE: &str = "(j.status = 'failed' OR (j.status = 'pending' AND j.next_run_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')))";
const MAX_ISSUES: i64 = 200;

#[derive(Debug, Serialize, PartialEq)]
pub struct JobCount {
    pub job_type: String,
    /// pending (ready) / backoff / running / failed. Succeeded jobs are not counted.
    pub state: String,
    pub count: i64,
}

#[derive(Debug, Serialize)]
pub struct JobIssue {
    pub id: i64,
    pub job_type: String,
    pub article_id: Option<i64>,
    pub article_title: Option<String>,
    pub status: String,
    pub attempt_count: i64,
    pub last_error: Option<String>,
    pub next_run_at: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct JobOverview {
    pub counts: Vec<JobCount>,
    /// Newest first, at most `MAX_ISSUES`; `counts` has the totals.
    pub issues: Vec<JobIssue>,
}

fn err(e: impl ToString) -> String {
    e.to_string()
}

pub fn overview(store: &Store) -> Result<JobOverview, String> {
    let c = store.conn();
    let mut st = c
        .prepare(&format!(
            "SELECT type, CASE WHEN status = 'pending' AND next_run_at > {NOW} THEN 'backoff' ELSE status END, count(*)
             FROM processing_jobs WHERE status IN ('pending', 'running', 'failed') GROUP BY 1, 2 ORDER BY 1, 2"
        ))
        .map_err(err)?;
    let counts =
        st.query_map([], |r| Ok(JobCount { job_type: r.get(0)?, state: r.get(1)?, count: r.get(2)? })).map_err(err)?.collect::<Result<_, _>>().map_err(err)?;
    let mut st = c
        .prepare(&format!(
            "SELECT j.id, j.type, j.article_id, coalesce(a.title, a.original_url, json_extract(j.params, '$.domain')), j.status, j.attempt_count, j.last_error,
                    j.next_run_at, j.created_at, j.started_at, j.completed_at
             FROM processing_jobs j LEFT JOIN articles a ON a.id = j.article_id
             WHERE {ISSUE} ORDER BY j.completed_at DESC, j.id DESC LIMIT ?1"
        ))
        .map_err(err)?;
    let issues = st
        .query_map([MAX_ISSUES], |r| {
            Ok(JobIssue {
                id: r.get(0)?,
                job_type: r.get(1)?,
                article_id: r.get(2)?,
                article_title: r.get(3)?,
                status: r.get(4)?,
                attempt_count: r.get(5)?,
                last_error: r.get(6)?,
                next_run_at: r.get(7)?,
                created_at: r.get(8)?,
                started_at: r.get(9)?,
                completed_at: r.get(10)?,
            })
        })
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err)?;
    Ok(JobOverview { counts, issues })
}

/// Re-queues one job now, as `Store::enqueue_job` does for a dedup key (status pending, backoff
/// and error cleared, a fresh set of attempts). Returns its type, to wake the right runner; None if running or gone.
pub fn retry(store: &Store, id: i64) -> Result<Option<String>, String> {
    store
        .conn()
        .query_row(
            "UPDATE processing_jobs SET status = 'pending', attempt_count = 0, last_error = NULL, next_run_at = NULL
             WHERE id = ?1 AND status != 'running' RETURNING type",
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)
}

/// Re-queues every failed or backing-off job, of `job_type` only when given.
pub fn retry_failed(store: &Store, job_type: Option<&str>) -> Result<usize, String> {
    store
        .conn()
        .execute(
            &format!("UPDATE processing_jobs AS j SET status = 'pending', attempt_count = 0, last_error = NULL, next_run_at = NULL WHERE {ISSUE} AND (?1 IS NULL OR j.type = ?1)"),
            params![job_type],
        )
        .map_err(err)
}

/// Deletes a pending or failed job; a running one finishes first. Returns whether it was deleted.
pub fn cancel(store: &Store, id: i64) -> Result<bool, String> {
    let n = store.conn().execute("DELETE FROM processing_jobs WHERE id = ?1 AND status IN ('pending', 'failed')", [id]).map_err(err)?;
    Ok(n > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fetch::Fetched;
    use crate::ingest::store_fetched;
    use crate::jobs::{LLM_JOBS, Providers, run_next};
    use crate::segments::tests::Fake;
    use crate::{classify, summarize};

    fn saved(s: &Store, n: usize) -> i64 {
        let url = format!("https://example.com/{n}");
        let (id, _) = s.upsert_pending(&url, &url, "example.com").unwrap();
        let html = format!(
            "<html><head><title>Post {n}</title></head><body><article><p>Snapshot isolation permits write skew, which serializable snapshot isolation prevents at commit time. This sentence pads the paragraph so readability keeps it. Post number {n}.</p></article></body></html>"
        );
        store_fetched(s, id, &Fetched { final_url: url, status: 200, content_type: None, html }).unwrap();
        id
    }

    struct NoEmbed;
    impl crate::embed::EmbeddingProvider for NoEmbed {
        fn model_id(&self) -> &str {
            "none"
        }
        async fn embed(&self, _: Vec<String>, _: crate::embed::Purpose) -> Result<Vec<Vec<f32>>, String> {
            Err("unused".into())
        }
    }

    #[tokio::test]
    async fn lists_failures_and_retries_batched_classify_jobs() {
        let s = Store::open_in_memory().unwrap();
        let ids: Vec<i64> = (0..3).map(|n| saved(&s, n)).collect();
        ids.iter().for_each(|&id| classify::enqueue(&s, id).unwrap());
        summarize::enqueue(&s, ids[0]).unwrap();
        let failing = Providers { llm: Fake { fail: true, ..Fake::new() }, embedder: NoEmbed, http: crate::fetch::client() };
        assert!(run_next(&s, &failing, &[classify::JOB_TYPE], &|_| {}).await.unwrap());
        s.exec_for_test(&format!("UPDATE processing_jobs SET status = 'failed' WHERE type = 'classify' AND article_id = {}", ids[2]));

        let o = overview(&s).unwrap();
        let count = |t: &str, st: &str| o.counts.iter().find(|c| c.job_type == t && c.state == st).map_or(0, |c| c.count);
        assert_eq!((count("classify", "backoff"), count("classify", "failed"), count("summarize", "pending")), (2, 1, 1));
        assert_eq!(o.issues.len(), 3);
        assert!(o.issues.iter().all(|i| i.attempt_count == 1 && i.last_error.is_some() && i.article_title.as_deref().unwrap().starts_with("Post")));

        assert_eq!(retry_failed(&s, Some(summarize::JOB_TYPE)).unwrap(), 0, "type filter");
        assert_eq!(retry(&s, o.issues[0].id).unwrap().as_deref(), Some("classify"));
        assert_eq!(retry_failed(&s, None).unwrap(), 2);
        assert!(overview(&s).unwrap().issues.is_empty());
        let attempts: i64 = s.conn().query_row("SELECT sum(attempt_count) FROM processing_jobs WHERE type = 'classify'", [], |r| r.get(0)).unwrap();
        assert_eq!(attempts, 0, "retried jobs get a full set of attempts");

        let ok = Providers { llm: Fake::new(), embedder: NoEmbed, http: crate::fetch::client() };
        assert!(run_next(&s, &ok, &[classify::JOB_TYPE], &|_| {}).await.unwrap());
        assert_eq!(ok.llm.calls.lock().unwrap().len(), 1, "the retried jobs run as one batch");
        assert!(ids.iter().all(|&id| s.article_row(id).unwrap().unwrap().genre.is_some()));

        let summary_job = s.get_article(ids[0], "ja").unwrap().unwrap().jobs.into_iter().find(|j| j.job_type == "summarize").unwrap();
        assert!(cancel(&s, summary_job.id).unwrap());
        assert!(!run_next(&s, &ok, LLM_JOBS, &|_| {}).await.unwrap(), "cancelled job is gone");
    }

    #[test]
    fn a_running_job_is_neither_cancelled_nor_retried() {
        let s = Store::open_in_memory().unwrap();
        let (id, _) = s.upsert_pending("https://example.com/1", "https://example.com/1", "example.com").unwrap();
        summarize::enqueue(&s, id).unwrap();
        let job = s.claim_next_job(&[summarize::JOB_TYPE]).unwrap().unwrap();
        assert!(!cancel(&s, job.id).unwrap());
        assert_eq!(retry(&s, job.id).unwrap(), None);
        assert_eq!(retry_failed(&s, None).unwrap(), 0);

        s.finish_job(job.id, Some("boom")).unwrap();
        assert_eq!(retry(&s, job.id).unwrap().as_deref(), Some(summarize::JOB_TYPE), "retryable once it has finished");
        assert!(cancel(&s, job.id).unwrap());
        assert_eq!((retry(&s, job.id).unwrap(), cancel(&s, job.id).unwrap()), (None, false), "gone");
    }
}
