-- Derived data: several translations per block may coexist; readers pick the newest
-- whose source_hash still matches blocks.text_hash.
CREATE TABLE translations (
    id              INTEGER PRIMARY KEY,
    block_id        INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    target_language TEXT NOT NULL,
    text            TEXT NOT NULL,
    source_hash     TEXT NOT NULL,
    provider        TEXT NOT NULL,
    model           TEXT,
    prompt_version  TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX translations_block ON translations(block_id, target_language);

CREATE TABLE processing_jobs (
    id            INTEGER PRIMARY KEY,
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
    completed_at  TEXT
);
CREATE INDEX processing_jobs_ready ON processing_jobs(status, next_run_at);
CREATE INDEX processing_jobs_article ON processing_jobs(article_id);
