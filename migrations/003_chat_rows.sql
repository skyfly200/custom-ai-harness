-- Chats as rows: each message is its own row, so a save sends only what changed and two devices
-- (or the server) can add messages to one chat without overwriting each other.
-- A safety copy of the whole-chat rows is kept in chats_before_rows (drop it once you are happy).
CREATE TABLE IF NOT EXISTS chats_before_rows AS SELECT * FROM chats;

ALTER TABLE chats ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 0;

ALTER TABLE chats ADD COLUMN IF NOT EXISTS msg_order jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS chat_messages (
    owner   text NOT NULL,
    chat_id text NOT NULL,
    id      text NOT NULL,
    data    jsonb NOT NULL,
    updated bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (owner, chat_id, id)
);

-- Split every stored chat into message rows. A message saved before messages had ids gets one here.
INSERT INTO chat_messages (owner, chat_id, id, data, updated)
SELECT c.owner, c.id, COALESCE(m.value->>'id', 'm' || m.ord),
       jsonb_set(m.value, '{id}', to_jsonb(COALESCE(m.value->>'id', 'm' || m.ord))), c.updated
FROM chats c, jsonb_array_elements(c.data->'messages') WITH ORDINALITY AS m(value, ord)
WHERE c.deleted_at IS NULL AND jsonb_typeof(c.data->'messages') = 'array'
ON CONFLICT (owner, chat_id, id) DO NOTHING;

UPDATE chats c SET
    msg_order = COALESCE((SELECT jsonb_agg(COALESCE(m.value->>'id', 'm' || m.ord) ORDER BY m.ord)
                          FROM jsonb_array_elements(c.data->'messages') WITH ORDINALITY AS m(value, ord)), '[]'::jsonb),
    data = c.data - 'messages'
WHERE c.deleted_at IS NULL AND jsonb_typeof(c.data->'messages') = 'array';
