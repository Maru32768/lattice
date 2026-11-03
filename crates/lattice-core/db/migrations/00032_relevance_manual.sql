-- The importance the user picked by hand. It wins over the model's score in `relevance`, which is kept: the pairs
-- of the two are what a later tuning of the rating prompt would learn from.
ALTER TABLE articles ADD COLUMN relevance_manual INTEGER CHECK (relevance_manual BETWEEN 1 AND 5);
