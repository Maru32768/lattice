-- Lexical search. trigram tokenizes Japanese and identifiers like pg_visibility alike;
-- terms under 3 characters fall back to LIKE (see lexical_search).
CREATE VIRTUAL TABLE blocks_fts USING fts5(text, content='blocks', content_rowid='id', tokenize='trigram');
CREATE TRIGGER blocks_fts_ai AFTER INSERT ON blocks BEGIN
    INSERT INTO blocks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER blocks_fts_ad AFTER DELETE ON blocks BEGIN
    INSERT INTO blocks_fts(blocks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER blocks_fts_au AFTER UPDATE OF text ON blocks BEGIN
    INSERT INTO blocks_fts(blocks_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO blocks_fts(rowid, text) VALUES (new.id, new.text);
END;
INSERT INTO blocks_fts(blocks_fts) VALUES ('rebuild');

-- Translations are indexed too, so a Japanese query finds English articles lexically.
CREATE VIRTUAL TABLE translations_fts USING fts5(text, content='translations', content_rowid='id', tokenize='trigram');
CREATE TRIGGER translations_fts_ai AFTER INSERT ON translations BEGIN
    INSERT INTO translations_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER translations_fts_ad AFTER DELETE ON translations BEGIN
    INSERT INTO translations_fts(translations_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
INSERT INTO translations_fts(translations_fts) VALUES ('rebuild');

-- One vector per (block, model): switching models re-embeds without losing the old index.
CREATE TABLE embeddings (
    block_id    INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    model       TEXT NOT NULL,
    vector      BLOB NOT NULL,   -- little-endian f32, L2-normalized
    source_hash TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (block_id, model)
);
