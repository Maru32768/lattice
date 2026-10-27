-- Article images (§6), stored once per content hash (sha256 of the bytes) across articles.
-- Raster formats only (sniffed): SVG can carry script and stays a link.
CREATE TABLE images (
    hash       TEXT PRIMARY KEY,
    mime       TEXT NOT NULL,
    bytes      BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Every image URL an article's blocks reference, tried or stored. Keyed by URL, not block id:
-- re-extraction matches image blocks by their alt text (often empty), so their ids can swap.
CREATE TABLE article_images (
    article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    src        TEXT NOT NULL,
    hash       TEXT,   -- NULL: not stored; error says why
    error      TEXT,
    PRIMARY KEY (article_id, src)
);
CREATE INDEX article_images_hash ON article_images(hash);
-- Garbage collection: bytes go when their last mapping does (article deleted or image dropped).
CREATE TRIGGER article_images_gc AFTER DELETE ON article_images WHEN old.hash IS NOT NULL BEGIN
    DELETE FROM images WHERE hash = old.hash AND NOT EXISTS (SELECT 1 FROM article_images WHERE hash = old.hash);
END;
