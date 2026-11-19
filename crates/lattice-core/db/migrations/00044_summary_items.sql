-- A summary's sentences and key points with the blocks they cite and the numbers the article lacks: a
-- `summarize::Items` as JSON, or NULL for a summary made before them.
ALTER TABLE summaries ADD COLUMN items TEXT;
