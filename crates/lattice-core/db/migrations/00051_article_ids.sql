-- The largest article id ever given. SQLite gives a new row the largest id in use + 1, which after the newest article is
-- deleted is that article's id, and a window keeps what it holds of an article by id (a memo it has not saved, the
-- revision it saved from). `upsert_pending` gives the next one; the trigger follows any other insert.
CREATE TABLE article_ids (last INTEGER NOT NULL);
INSERT INTO article_ids SELECT coalesce(max(id), 0) FROM articles;
CREATE TRIGGER article_ids_ai AFTER INSERT ON articles WHEN new.id > (SELECT last FROM article_ids) BEGIN
    UPDATE article_ids SET last = new.id;
END;
