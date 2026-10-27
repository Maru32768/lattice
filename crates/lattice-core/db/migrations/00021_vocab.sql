-- Vocabulary (G56, vocab.rs): one entry per word or phrase, merged by lemma, with every sentence
-- it was captured in. A source article or block that goes away leaves the word and its URL.
CREATE TABLE vocab_entries (
    id         INTEGER PRIMARY KEY,
    headword   TEXT NOT NULL,   -- the lemma once the LLM answered; until then the form captured
    state      TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready', 'failed')),
    pos        TEXT NOT NULL DEFAULT '',
    meaning    TEXT NOT NULL DEFAULT '',   -- Japanese, as used in the first capture
    definition TEXT NOT NULL DEFAULT '',   -- short, in English
    ipa        TEXT NOT NULL DEFAULT '',
    example    TEXT NOT NULL DEFAULT '',
    suspended  INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX vocab_entries_headword ON vocab_entries(lower(headword));
CREATE TABLE vocab_contexts (
    id         INTEGER PRIMARY KEY,
    entry_id   INTEGER NOT NULL REFERENCES vocab_entries(id) ON DELETE CASCADE,
    surface    TEXT NOT NULL,   -- the form as it appears in the sentence
    sentence   TEXT NOT NULL,
    article_id INTEGER REFERENCES articles(id) ON DELETE SET NULL,
    block_id   INTEGER REFERENCES blocks(id) ON DELETE SET NULL,
    url        TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX vocab_contexts_entry ON vocab_contexts(entry_id);
CREATE INDEX vocab_contexts_surface ON vocab_contexts(lower(surface));
CREATE INDEX vocab_contexts_article ON vocab_contexts(article_id);
CREATE INDEX vocab_contexts_block ON vocab_contexts(block_id);
-- Two cards per entry with a meaning, scheduled like review_cards (srs.rs).
CREATE TABLE vocab_cards (
    id               INTEGER PRIMARY KEY,
    entry_id         INTEGER NOT NULL REFERENCES vocab_entries(id) ON DELETE CASCADE,
    kind             TEXT NOT NULL CHECK (kind IN ('cloze', 'meaning')),
    ease             INTEGER NOT NULL,   -- permille
    interval_minutes INTEGER NOT NULL,   -- 0: new, never answered
    reps             INTEGER NOT NULL,
    lapses           INTEGER NOT NULL,
    due_at           INTEGER NOT NULL,   -- unix seconds
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (entry_id, kind)
);
CREATE INDEX vocab_cards_due ON vocab_cards(interval_minutes, due_at);
CREATE TABLE vocab_log (
    id                    INTEGER PRIMARY KEY,
    card_id               INTEGER NOT NULL REFERENCES vocab_cards(id) ON DELETE CASCADE,
    grade                 TEXT NOT NULL CHECK (grade IN ('again', 'hard', 'good', 'easy')),
    prev_interval_minutes INTEGER NOT NULL,   -- 0: the card's first answer (counts as a new card that day)
    interval_minutes      INTEGER NOT NULL,
    ease                  INTEGER NOT NULL,
    reviewed_at           INTEGER NOT NULL    -- unix seconds
);
CREATE INDEX vocab_log_card ON vocab_log(card_id);
CREATE INDEX vocab_log_time ON vocab_log(reviewed_at);
