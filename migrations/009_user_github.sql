-- A person's own GitHub token for Runs on a hosted server: clones their repos and pushes run branches.
-- Encrypted with ENCRYPTION_KEY (utils/secrets.js); the database never holds one in the clear.
CREATE TABLE IF NOT EXISTS user_github (
    owner      text PRIMARY KEY,
    login      text NOT NULL,
    secret_enc text NOT NULL,
    updated    bigint NOT NULL
);
