-- What the phone has sent and this library has applied (`mobile::apply`): sending again changes nothing.
CREATE TABLE mobile_ops_applied (
    id         TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
) WITHOUT ROWID;
