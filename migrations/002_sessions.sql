-- Browser sessions, so a sleeping or restarted server doesn't sign everyone out.
-- Only a hash of the cookie value is stored.
CREATE TABLE IF NOT EXISTS sessions (
    id_hash text PRIMARY KEY,
    name    text NOT NULL,
    expires bigint NOT NULL
);
