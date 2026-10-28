-- A person's own OpenRouter federation policy: the harness signs a token for them (utils/oidcIssuer.js)
-- and OpenRouter trades it for a short-lived key. Nothing secret is stored.
ALTER TABLE user_credentials ADD COLUMN IF NOT EXISTS policy_id text;
ALTER TABLE user_credentials ADD COLUMN IF NOT EXISTS audience text;
