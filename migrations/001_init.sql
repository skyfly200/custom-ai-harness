-- Hosted storage: the users store (users.json when there is no database), chats and per-user data.

-- One JSON document per named store; "users" holds what users.json holds in local mode.
CREATE TABLE IF NOT EXISTS harness_store (
    name       text PRIMARY KEY,
    data       jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- A chat is the whole object the chat page keeps (messages, tool calls, settings).
-- "updated" is the page's own millisecond clock, used to decide which copy is newer.
CREATE TABLE IF NOT EXISTS chats (
    owner      text NOT NULL,
    id         text NOT NULL,
    title      text NOT NULL DEFAULT '',
    project    text,
    updated    bigint NOT NULL,
    data       jsonb NOT NULL,
    deleted_at timestamptz,
    PRIMARY KEY (owner, id)
);
CREATE INDEX IF NOT EXISTS chats_owner_updated ON chats (owner, updated DESC);

-- Projects, skills, commands, schedules and the preferences that follow the person.
CREATE TABLE IF NOT EXISTS user_data (
    owner      text NOT NULL,
    key        text NOT NULL,
    value      jsonb NOT NULL,
    updated    bigint NOT NULL,
    PRIMARY KEY (owner, key)
);
