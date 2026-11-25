-- A passage the reader asked about, and the answers kept beside it. `block_id` is the block the passage starts in, NULL
-- once the article no longer has it.
CREATE TABLE stickies (
    id         INTEGER PRIMARY KEY,
    article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    block_id   INTEGER REFERENCES blocks(id) ON DELETE SET NULL,
    kind       TEXT NOT NULL,
    quote      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX stickies_article ON stickies(article_id);
-- Migration 45 says why a SET NULL column needs one.
CREATE INDEX stickies_block ON stickies(block_id);

-- `question` is '' where the kind alone is the question.
CREATE TABLE sticky_messages (
    id             INTEGER PRIMARY KEY,
    sticky_id      INTEGER NOT NULL REFERENCES stickies(id) ON DELETE CASCADE,
    question       TEXT NOT NULL,
    answer         TEXT NOT NULL,
    citations      TEXT NOT NULL,
    provider       TEXT,
    model          TEXT,
    prompt_version TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX sticky_messages_sticky ON sticky_messages(sticky_id);
