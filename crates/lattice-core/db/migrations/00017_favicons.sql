-- Site icons per domain (favicons.rs). A failure is a row too (bytes NULL, error set), so a
-- site without an icon is not asked again until the row is a week old.
CREATE TABLE favicons (
    domain     TEXT PRIMARY KEY,
    mime       TEXT,
    bytes      BLOB,
    error      TEXT,
    fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
