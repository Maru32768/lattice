-- Where a sticky's passage was selected: 'text' in the article (or its translation), 'answer' in an answer of another sticky.
-- It stays 'answer' once `parent_message_id` is NULL: the passage is still not the article's. A child whose parent was gone
-- before this migration cannot be told from one on the text, and stays 'text'.
ALTER TABLE stickies ADD COLUMN origin TEXT NOT NULL DEFAULT 'text';
UPDATE stickies SET origin = 'answer' WHERE parent_message_id IS NOT NULL;
