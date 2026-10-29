-- Token usage per person per day (utils/usageDb.js), so the Usage page keeps each user's totals across
-- restarts and the admin view can total everyone. user_name '' holds usage from before per-user tracking,
-- and requests with no signed-in person. One row per day + person + client + route + model + servedBy + provider.
CREATE TABLE IF NOT EXISTS usage_daily (
    day           text    NOT NULL,
    user_name     text    NOT NULL DEFAULT '',
    client        text    NOT NULL,
    route         text    NOT NULL,
    model         text    NOT NULL,
    served_by     text    NOT NULL,
    provider      text    NOT NULL,
    requests      bigint  NOT NULL DEFAULT 0,
    input         bigint  NOT NULL DEFAULT 0,
    output        bigint  NOT NULL DEFAULT 0,
    cache_read    bigint  NOT NULL DEFAULT 0,
    cache_write   bigint  NOT NULL DEFAULT 0,
    estimated     bigint  NOT NULL DEFAULT 0,
    saved_anchor  bigint  NOT NULL DEFAULT 0,
    saved_headroom bigint NOT NULL DEFAULT 0,
    upstream      text,
    last_at       timestamptz,
    PRIMARY KEY (day, user_name, client, route, model, served_by, provider)
);
CREATE INDEX IF NOT EXISTS usage_daily_user ON usage_daily (user_name, day);
CREATE INDEX IF NOT EXISTS usage_daily_day ON usage_daily (day);
