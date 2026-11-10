-- The saved article whose Page view made a translation; NULL for one the translate job made (its block has the text)
-- and for one made on a page not in the library. A translation that is neither of a block nor of a saved page is
-- one no article uses (`Store::unused_translations`). Another saved page claims its own when its Page view shows them
-- (`claim_segments`).
ALTER TABLE segment_translations ADD COLUMN article_id INTEGER REFERENCES articles(id) ON DELETE SET NULL;
CREATE INDEX segment_translations_article ON segment_translations(article_id) WHERE article_id IS NOT NULL;
-- The rows a saved PDF's Page view made before this are given that PDF by `Store::own_pdf_regions`, the first time
-- unused translations are counted: laying a large PDF out here would hold up the start.
INSERT OR IGNORE INTO settings (key, value) SELECT 'translations.pdf_regions_pending', '1'
WHERE EXISTS (SELECT 1 FROM snapshots WHERE content_type = 'application/pdf') AND EXISTS (SELECT 1 FROM segment_translations);
