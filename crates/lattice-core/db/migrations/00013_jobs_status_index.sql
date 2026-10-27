-- Jobs view: counts per (status, type) and the backed-off list without touching table rows.
CREATE INDEX processing_jobs_status_type ON processing_jobs(status, type, next_run_at);
