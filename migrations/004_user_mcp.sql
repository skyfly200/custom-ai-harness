-- Each person's own MCP servers (remote only). The whole entry, headers and keys included, is
-- encrypted with ENCRYPTION_KEY (utils/secrets.js); the database never holds one in the clear.
CREATE TABLE IF NOT EXISTS user_mcp (
    owner      text NOT NULL,
    name       text NOT NULL,
    spec_enc   text NOT NULL,
    updated    bigint NOT NULL,
    PRIMARY KEY (owner, name)
);
