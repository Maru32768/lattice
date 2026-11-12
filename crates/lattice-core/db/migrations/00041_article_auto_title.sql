-- The title the app found for an article the user renamed: `title` holds the user's name, and a refetch updates
-- this one instead, so clearing the name brings back the current one (`Store::set_title`). NULL when not renamed.
ALTER TABLE articles ADD COLUMN auto_title TEXT;
