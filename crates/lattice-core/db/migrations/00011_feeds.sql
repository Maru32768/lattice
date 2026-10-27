CREATE TABLE feeds (
    id              INTEGER PRIMARY KEY,
    url             TEXT NOT NULL UNIQUE,
    title           TEXT,
    site_url        TEXT,
    etag            TEXT,
    last_modified   TEXT,
    last_fetched_at TEXT,   -- last successful fetch
    last_error      TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Every entry URL a feed has listed, imported or not: only unseen entries get imported.
CREATE TABLE feed_items (
    feed_id        INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
    normalized_url TEXT NOT NULL,
    PRIMARY KEY (feed_id, normalized_url)
);
-- Removing a feed keeps its articles (they fall back to manually added).
ALTER TABLE articles ADD COLUMN feed_id INTEGER REFERENCES feeds(id) ON DELETE SET NULL;
CREATE INDEX articles_feed ON articles(feed_id);
