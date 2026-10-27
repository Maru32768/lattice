-- Vocabulary cards are Anki's basic word -> meaning only (H20, vocab.rs): the cloze cards go, with
-- their log. The meaning cards keep their schedule and log.
DELETE FROM vocab_cards WHERE kind = 'cloze';
