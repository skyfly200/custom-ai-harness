-- "Connect GitHub" (OAuth): the same row as a pasted token, plus how it was made and, for a GitHub App,
-- its refresh token and when the access token runs out (an App's user tokens last 8 hours).
ALTER TABLE user_github ADD COLUMN IF NOT EXISTS via         text   NOT NULL DEFAULT 'token';
ALTER TABLE user_github ADD COLUMN IF NOT EXISTS refresh_enc text;
ALTER TABLE user_github ADD COLUMN IF NOT EXISTS expires     bigint NOT NULL DEFAULT 0;
