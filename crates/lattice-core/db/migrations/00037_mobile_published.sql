-- What the phone's snapshot bucket holds, by the hash of each object as uploaded (`mobile_publish`).
CREATE TABLE mobile_published (
    key  TEXT PRIMARY KEY,
    hash TEXT NOT NULL
) WITHOUT ROWID;
