-- Genres (§11 topic): one per article. genre_source 'manual' pins the user's choice against auto runs.
CREATE TABLE genres (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
INSERT INTO genres (name) VALUES ('Database'), ('Distributed Systems'), ('Linux'), ('Networking'),
    ('Programming Languages'), ('Security'), ('Web'), ('AI/ML'), ('DevOps'), ('Hardware'), ('Career'), ('Other');
ALTER TABLE articles ADD COLUMN genre_id INTEGER REFERENCES genres(id) ON DELETE SET NULL;
ALTER TABLE articles ADD COLUMN genre_source TEXT CHECK (genre_source IN ('auto', 'manual'));
CREATE INDEX articles_genre ON articles(genre_id);
CREATE INDEX articles_published_at ON articles(published_at);
-- Derived data: every auto classification, as summaries keep theirs.
CREATE TABLE classifications (
    id             INTEGER PRIMARY KEY,
    article_id     INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    genre          TEXT NOT NULL,
    tags           TEXT NOT NULL,   -- JSON array
    provider       TEXT NOT NULL,
    model          TEXT,
    prompt_version TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX classifications_article ON classifications(article_id);
