-- The saved article whose Page view made a translation; NULL for one the translate job made (its block has the text)
-- and for one made on a page not in the library. A translation that is neither of a block nor of a saved page is
-- one no article uses (`Store::unused_translations`). store::own_pdf_regions gives the rows made before this to the
-- saved PDF whose regions they are; what other saved pages' Page views made is not known and stays NULL.
ALTER TABLE segment_translations ADD COLUMN article_id INTEGER REFERENCES articles(id) ON DELETE SET NULL;
CREATE INDEX segment_translations_article ON segment_translations(article_id) WHERE article_id IS NOT NULL;
