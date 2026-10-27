-- The entry's own title, and its full text when the feed carries one (deflated HTML; NULL for
-- excerpts): read in place of the page when the site refuses to serve it (feeds::Entry).
ALTER TABLE feed_items ADD COLUMN title TEXT;
ALTER TABLE feed_items ADD COLUMN content BLOB;
-- So the next poll gets every feed in full and fills these for entries seen before.
UPDATE feeds SET etag = NULL, last_modified = NULL;
