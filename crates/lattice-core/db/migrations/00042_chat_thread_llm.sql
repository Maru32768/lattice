-- The model a chat thread asks: a `ChainEntry` as JSON, or NULL for the AI provider chain in Settings.
ALTER TABLE chat_threads ADD COLUMN llm TEXT;
