-- The entry's published (else updated) date: fills articles.published_at when the page has none.
ALTER TABLE feed_items ADD COLUMN published_at TEXT;
