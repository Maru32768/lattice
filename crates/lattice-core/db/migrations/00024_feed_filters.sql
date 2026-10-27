-- Feed import filters (G55, feed_filter.rs). feeds.filter: the feed's own (JSON feed_filter::Filter;
-- the global one is the 'feed_filter' setting). filter_note: why the LLM filter last let entries
-- through unjudged (it fails open).
ALTER TABLE feeds ADD COLUMN filter TEXT;
ALTER TABLE feeds ADD COLUMN filter_note TEXT;
-- What the filters decided for an entry seen from now on: 'passed' (queued), 'rejected'
-- (filter_reason: JSON feed_filter::Reason) or 'pending' (waiting for the LLM filter). NULL: seen
-- before G55, or past the first-fetch cap. filter_input is what the rules read
-- (feed_filter::Input), so rejected entries can be judged again after the rules change.
ALTER TABLE feed_items ADD COLUMN filter_status TEXT CHECK (filter_status IN ('passed', 'rejected', 'pending'));
ALTER TABLE feed_items ADD COLUMN filter_reason TEXT;
ALTER TABLE feed_items ADD COLUMN filter_input TEXT;
CREATE INDEX feed_items_filter ON feed_items(filter_status, feed_id) WHERE filter_status IN ('rejected', 'pending');
