CREATE TABLE summaries (
    id             INTEGER PRIMARY KEY,
    article_id     INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    type           TEXT NOT NULL,
    text           TEXT NOT NULL,
    source_hash    TEXT NOT NULL,   -- articles.content_hash when generated
    provider       TEXT NOT NULL,
    model          TEXT,
    prompt_version TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX summaries_article ON summaries(article_id, type);
