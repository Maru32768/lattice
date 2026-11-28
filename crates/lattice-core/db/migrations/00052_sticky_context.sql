-- The text right before and right after a sticky's passage where it was selected, to tell it from the same text elsewhere in
-- its block or answer. Not an offset: switching a sentence to the other language, or extracting the article again, moves
-- every offset after it. NULL on the stickies from before, which fall back to the first place the passage is.
ALTER TABLE stickies ADD COLUMN quote_prefix TEXT;
ALTER TABLE stickies ADD COLUMN quote_suffix TEXT;
