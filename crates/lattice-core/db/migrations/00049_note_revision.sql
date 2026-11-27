-- Raised by every save: a save written from an older revision is refused, so a window holding an old copy of the memo
-- cannot save over another window's. A blank memo keeps its row with body '' so that the revision never goes back.
ALTER TABLE article_notes ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
