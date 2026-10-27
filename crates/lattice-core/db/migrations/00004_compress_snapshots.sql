-- Snapshots get compressed (raw HTML is 100KB-1MB per article). Existing rows stay as-is.
CREATE TABLE snapshots_v2 (
    id           INTEGER PRIMARY KEY,
    article_id   INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    fetched_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    final_url    TEXT NOT NULL,
    http_status  INTEGER NOT NULL,
    content_type TEXT,
    encoding     TEXT NOT NULL CHECK (encoding IN ('identity', 'deflate')),
    body         BLOB NOT NULL
);
INSERT INTO snapshots_v2 (id, article_id, fetched_at, final_url, http_status, content_type, encoding, body)
    SELECT id, article_id, fetched_at, final_url, http_status, content_type, 'identity', CAST(html AS BLOB) FROM snapshots;
DROP TABLE snapshots;
ALTER TABLE snapshots_v2 RENAME TO snapshots;
CREATE INDEX snapshots_article ON snapshots(article_id);
