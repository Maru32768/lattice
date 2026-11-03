-- When the process running the job last showed it was alive (jobs::keep_alive). The app, the CLI and
-- the MCP server share the queue, so a running job is reset only once its heartbeat has stopped.
ALTER TABLE processing_jobs ADD COLUMN heartbeat_at TEXT;
