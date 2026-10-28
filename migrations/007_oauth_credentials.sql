-- Per-person federation is gone (people connect OpenRouter with OAuth instead, utils/openrouterOAuth.js).
DELETE FROM user_credentials WHERE kind = 'federation';
ALTER TABLE user_credentials DROP COLUMN IF EXISTS policy_id;
ALTER TABLE user_credentials DROP COLUMN IF EXISTS audience;
