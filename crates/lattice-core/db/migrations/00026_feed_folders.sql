-- Feed folders (H25, feed_folders.rs): named and ordered, not nested; a feed is in at most one.
-- Deleting a folder leaves its feeds without one.
CREATE TABLE feed_folders (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    position   INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
ALTER TABLE feeds ADD COLUMN folder_id INTEGER REFERENCES feed_folders(id) ON DELETE SET NULL;
CREATE INDEX feeds_folder ON feeds(folder_id);
