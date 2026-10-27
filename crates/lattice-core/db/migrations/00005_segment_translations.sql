-- Translations become a cache keyed by the paragraph's plain-text hash (= blocks.text_hash),
-- holding reading units [{source, translation}] as HTML. Shared by the live page overlay,
-- the reader and search; independent of articles, so it also survives re-extraction.
CREATE TABLE segment_translations (
    id              INTEGER PRIMARY KEY,
    source_hash     TEXT NOT NULL,
    target_language TEXT NOT NULL,
    units           TEXT NOT NULL,
    text            TEXT NOT NULL,   -- plain translated text, for search and the reader view
    provider        TEXT NOT NULL,
    model           TEXT,
    prompt_version  TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX segment_translations_hash ON segment_translations(source_hash, target_language);
INSERT INTO segment_translations (source_hash, target_language, units, text, provider, model, prompt_version, created_at)
    SELECT t.source_hash, t.target_language, json_array(json_object('source', b.text, 'translation', t.text)),
           t.text, t.provider, t.model, t.prompt_version, t.created_at
    FROM translations t JOIN blocks b ON b.id = t.block_id ORDER BY t.id;
DROP TRIGGER translations_fts_ai;
DROP TRIGGER translations_fts_ad;
DROP TABLE translations_fts;
DROP TABLE translations;
CREATE VIRTUAL TABLE translations_fts USING fts5(text, content='segment_translations', content_rowid='id', tokenize='trigram');
CREATE TRIGGER translations_fts_ai AFTER INSERT ON segment_translations BEGIN
    INSERT INTO translations_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER translations_fts_ad AFTER DELETE ON segment_translations BEGIN
    INSERT INTO translations_fts(translations_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
INSERT INTO translations_fts(translations_fts) VALUES ('rebuild');
CREATE INDEX blocks_text_hash ON blocks(text_hash);
