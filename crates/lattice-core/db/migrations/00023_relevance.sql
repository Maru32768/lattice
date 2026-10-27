-- Importance for the reader (G54, relevance.rs): 1-5 against the 「自分について」 profile, with a
-- one-line reason. Only the newest judgment is kept. profile_hash is the profile it was judged
-- against; settings 'user_profile_hash' holds the current one, so editing the profile makes it stale.
CREATE TABLE relevance (
    article_id     INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
    score          INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
    reason         TEXT NOT NULL,
    profile_hash   TEXT NOT NULL,
    provider       TEXT NOT NULL,
    model          TEXT,
    prompt_version TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX relevance_score ON relevance(score);
