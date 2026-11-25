-- The message whose answer a child sticky's passage was selected in; NULL for a passage of the article, and once that message
-- is gone.
ALTER TABLE stickies ADD COLUMN parent_message_id INTEGER REFERENCES sticky_messages(id) ON DELETE SET NULL;
-- Migration 45 says why a SET NULL column needs one.
CREATE INDEX stickies_parent ON stickies(parent_message_id);
