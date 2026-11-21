-- Deleting a block sets blocks.heading_id to NULL where it points at that block, and without an index SQLite finds them
-- by reading every block: about a second per deleted block in a library of 450,000, while the store is held. A
-- re-extraction that replaces 50 paragraphs held it for nearly two minutes.
CREATE INDEX blocks_heading ON blocks(heading_id);
