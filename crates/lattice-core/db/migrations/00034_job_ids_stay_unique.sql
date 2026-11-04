-- A deleted job's id must not come back. SQLite gives a freed highest id to the next insert, and a job
-- still running would take that row for its own: its stop check and finish_job go by id.
CREATE TABLE processing_jobs_new (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    type          TEXT NOT NULL,
    article_id    INTEGER REFERENCES articles(id) ON DELETE CASCADE,
    params        TEXT,
    dedup_key     TEXT NOT NULL UNIQUE,
    status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT,
    next_run_at   TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    started_at    TEXT,
    completed_at  TEXT,
    heartbeat_at  TEXT
);
INSERT INTO processing_jobs_new (id, type, article_id, params, dedup_key, status, attempt_count, last_error, next_run_at, created_at, started_at, completed_at, heartbeat_at)
    SELECT id, type, article_id, params, dedup_key, status, attempt_count, last_error, next_run_at, created_at, started_at, completed_at, heartbeat_at FROM processing_jobs;
DROP TABLE processing_jobs;
ALTER TABLE processing_jobs_new RENAME TO processing_jobs;
CREATE INDEX processing_jobs_article ON processing_jobs(article_id);
CREATE INDEX processing_jobs_ready ON processing_jobs(status, next_run_at);
CREATE INDEX processing_jobs_status_type ON processing_jobs(status, type, next_run_at);
