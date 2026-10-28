-- Guest credit: a hard lifetime cap per guest, in millionths of a dollar. Money is reserved before a
-- request goes out and settled to the real cost after, so concurrent requests can't pass the cap.
CREATE TABLE IF NOT EXISTS credit_accounts (
    owner          text PRIMARY KEY,
    cap_micro      bigint NOT NULL,
    spent_micro    bigint NOT NULL DEFAULT 0,
    reserved_micro bigint NOT NULL DEFAULT 0,
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- One row per request in flight. A row nobody settled (a crash) is charged in full when it expires.
CREATE TABLE IF NOT EXISTS credit_holds (
    id           text PRIMARY KEY,
    owner        text NOT NULL,
    amount_micro bigint NOT NULL,
    expires_at   timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS credit_holds_expires ON credit_holds (expires_at);

-- A person's own OpenRouter credential: a pasted key, encrypted with ENCRYPTION_KEY.
CREATE TABLE IF NOT EXISTS user_credentials (
    owner      text PRIMARY KEY,
    kind       text NOT NULL,
    secret_enc text,
    updated    bigint NOT NULL
);
