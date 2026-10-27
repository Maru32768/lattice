-- The user's name and icon for a feed (feeds::rename / set_icon); NULL shows the feed's own
-- title and the site's favicon. title keeps the feed's own, so the name can be reset.
ALTER TABLE feeds ADD COLUMN custom_title TEXT;
ALTER TABLE feeds ADD COLUMN icon_mime TEXT;
ALTER TABLE feeds ADD COLUMN icon BLOB;
