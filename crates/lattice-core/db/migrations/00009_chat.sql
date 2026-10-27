-- Chat over saved articles (F9). Scope and citations are JSON; citations copy the cited
-- block's title/heading/text so old answers still render after re-extraction or deletion.
CREATE TABLE chat_threads (
    id         INTEGER PRIMARY KEY,
    title      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE chat_messages (
    id             INTEGER PRIMARY KEY,
    thread_id      INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    question       TEXT NOT NULL,
    answer         TEXT NOT NULL,
    citations      TEXT NOT NULL,
    scope          TEXT NOT NULL,
    mode           TEXT NOT NULL CHECK (mode IN ('full', 'retrieval', 'none')),
    provider       TEXT,
    model          TEXT,
    prompt_version TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX chat_messages_thread ON chat_messages(thread_id);
