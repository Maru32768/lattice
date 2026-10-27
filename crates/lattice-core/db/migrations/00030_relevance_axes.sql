-- Relevance v2 (relevance.rs): the two judgments behind the score, kept for diagnosis. fit is how
-- close the topic is to the profile, value what reading it would give the reader. NULL on scores
-- from relevance-v1, which the prompt version already marks stale.
ALTER TABLE relevance ADD COLUMN fit INTEGER CHECK (fit BETWEEN 1 AND 5);
ALTER TABLE relevance ADD COLUMN value INTEGER CHECK (value BETWEEN 1 AND 5);
