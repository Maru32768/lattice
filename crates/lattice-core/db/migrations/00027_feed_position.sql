-- The user's order of feeds within their folder, or among the feeds in none (H26, feed_folders.rs).
-- Existing feeds keep the order they were shown in: by name.
ALTER TABLE feeds ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
UPDATE feeds SET position = (
    SELECT n FROM (
        SELECT id, row_number() OVER (PARTITION BY folder_id ORDER BY coalesce(custom_title, title, url) COLLATE NOCASE, id) - 1 AS n FROM feeds
    ) o WHERE o.id = feeds.id
);
