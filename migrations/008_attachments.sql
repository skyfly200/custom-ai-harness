-- Chat attachments (images and text files), kept apart from the chat text. A message row holds only
-- a stub (name, kind, size, attachment id); the bytes live here. "body" is the image as a data URL
-- or the file's text, as the page keeps it. Deleting a chat deletes its attachments.
CREATE TABLE IF NOT EXISTS attachments (
    owner      text NOT NULL,
    chat_id    text NOT NULL,
    id         text NOT NULL,
    kind       text NOT NULL,
    name       text NOT NULL,
    size       bigint NOT NULL,
    body       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner, chat_id, id)
);
CREATE INDEX IF NOT EXISTS attachments_owner ON attachments (owner);
