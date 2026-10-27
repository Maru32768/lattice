-- Difficulty for a working software engineer, 1 (入門) to 5 (専門), from the classify job.
-- difficulty_source 'manual' pins the user's choice against auto runs, as genre_source does.
ALTER TABLE articles ADD COLUMN difficulty INTEGER CHECK (difficulty BETWEEN 1 AND 5);
ALTER TABLE articles ADD COLUMN difficulty_source TEXT CHECK (difficulty_source IN ('auto', 'manual'));
ALTER TABLE classifications ADD COLUMN difficulty INTEGER;
