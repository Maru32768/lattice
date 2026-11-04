-- The user turned automatic translation off for this article: it is translated only when asked.
ALTER TABLE articles ADD COLUMN translate_manual INTEGER NOT NULL DEFAULT 0;
