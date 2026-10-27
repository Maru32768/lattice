-- Extracted text length (characters): flags pages whose server HTML has almost no content
-- (JS-rendered), so the user can re-save them from the in-app browser.
ALTER TABLE articles ADD COLUMN text_length INTEGER;
UPDATE articles SET text_length = (SELECT coalesce(sum(length(text)), 0) FROM blocks WHERE article_id = articles.id)
    WHERE extraction_status = 'ok';
