-- Keys the harness issues itself through OpenRouter's Management API (utils/openrouterKeys.js): the key's hash, so
-- it can be revoked or replaced, and when it expires (null: never).
ALTER TABLE user_credentials ADD COLUMN IF NOT EXISTS key_hash text;
ALTER TABLE user_credentials ADD COLUMN IF NOT EXISTS expires bigint;
