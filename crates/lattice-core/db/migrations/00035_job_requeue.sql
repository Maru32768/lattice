-- Asked for again while running: the job runs once more when it finishes (`jobs::RUN_AGAIN_IF_ASKED`).
ALTER TABLE processing_jobs ADD COLUMN requeue INTEGER NOT NULL DEFAULT 0;
