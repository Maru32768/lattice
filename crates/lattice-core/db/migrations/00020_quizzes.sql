-- Comprehension quizzes (G32, quiz.rs). Every generation is kept, as summaries are; the newest is current.
CREATE TABLE quizzes (
    id             INTEGER PRIMARY KEY,
    article_id     INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    source_hash    TEXT NOT NULL,   -- articles.content_hash when generated
    provider       TEXT NOT NULL,
    model          TEXT,
    prompt_version TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX quizzes_article ON quizzes(article_id);
CREATE TABLE quiz_questions (
    id          INTEGER PRIMARY KEY,
    quiz_id     INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    ordinal     INTEGER NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('recall', 'choice')),
    question    TEXT NOT NULL,
    options     TEXT NOT NULL,   -- JSON array: four for 'choice' (answer is one of them), empty for 'recall'
    answer      TEXT NOT NULL,
    explanation TEXT NOT NULL,
    block_ids   TEXT NOT NULL,   -- JSON array of the blocks.id the answer comes from
    UNIQUE (quiz_id, ordinal)
);
-- Spaced repetition (srs.rs): one card per question the user added to review.
CREATE TABLE review_cards (
    question_id      INTEGER PRIMARY KEY REFERENCES quiz_questions(id) ON DELETE CASCADE,
    ease             INTEGER NOT NULL,   -- permille
    interval_minutes INTEGER NOT NULL,   -- 0: new, never answered
    reps             INTEGER NOT NULL,
    lapses           INTEGER NOT NULL,
    due_at           INTEGER NOT NULL,   -- unix seconds
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX review_cards_due ON review_cards(interval_minutes, due_at);
CREATE TABLE review_log (
    id                    INTEGER PRIMARY KEY,
    question_id           INTEGER NOT NULL REFERENCES review_cards(question_id) ON DELETE CASCADE,
    grade                 TEXT NOT NULL CHECK (grade IN ('again', 'hard', 'good', 'easy')),
    prev_interval_minutes INTEGER NOT NULL,   -- 0: the card's first answer (counts as a new card that day)
    interval_minutes      INTEGER NOT NULL,
    ease                  INTEGER NOT NULL,
    reviewed_at           INTEGER NOT NULL    -- unix seconds
);
CREATE INDEX review_log_card ON review_log(question_id);
CREATE INDEX review_log_time ON review_log(reviewed_at);
