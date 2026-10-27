CREATE TABLE articles (
    id                 INTEGER PRIMARY KEY,
    original_url       TEXT NOT NULL,
    normalized_url     TEXT NOT NULL UNIQUE,
    canonical_url      TEXT,
    domain             TEXT NOT NULL,
    title              TEXT,
    author             TEXT,
    site_name          TEXT,
    published_at       TEXT,
    language           TEXT,
    saved_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    fetched_at         TEXT,
    fetch_status       TEXT NOT NULL DEFAULT 'pending' CHECK (fetch_status IN ('pending','ok','failed')),
    extraction_status  TEXT NOT NULL DEFAULT 'pending' CHECK (extraction_status IN ('pending','ok','failed')),
    last_error         TEXT,
    content_hash       TEXT,
    extraction_version INTEGER,
    read_status        TEXT NOT NULL DEFAULT 'unread' CHECK (read_status IN ('unread','read')),
    favorite           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX articles_canonical ON articles(canonical_url);
CREATE INDEX articles_content_hash ON articles(content_hash);
CREATE INDEX articles_saved_at ON articles(saved_at);

-- Raw HTML as fetched: lets us re-extract without the network and survive link rot.
CREATE TABLE snapshots (
    id           INTEGER PRIMARY KEY,
    article_id   INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    fetched_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    final_url    TEXT NOT NULL,
    http_status  INTEGER NOT NULL,
    content_type TEXT,
    html         TEXT NOT NULL
);
CREATE INDEX snapshots_article ON snapshots(article_id);

CREATE TABLE blocks (
    id          INTEGER PRIMARY KEY,
    article_id  INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    ordinal     INTEGER NOT NULL,
    kind        TEXT NOT NULL,
    text        TEXT NOT NULL,
    text_hash   TEXT NOT NULL,
    inlines     TEXT,
    attrs       TEXT,
    heading_id  INTEGER REFERENCES blocks(id) ON DELETE SET NULL,
    UNIQUE (article_id, ordinal)
);
