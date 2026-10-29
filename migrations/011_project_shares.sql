-- Project sharing. A project is private to its owner unless a row here says otherwise.
-- grantee is a user name, or '*' for every signed-in (non-guest) user. role: 'view' reads the project and its
-- chats, 'edit' also writes them. The chats and the project itself stay in the owner's rows.
CREATE TABLE IF NOT EXISTS project_shares (
    owner      text NOT NULL,
    project_id text NOT NULL,
    grantee    text NOT NULL,
    role       text NOT NULL CHECK (role IN ('view', 'edit')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner, project_id, grantee)
);
CREATE INDEX IF NOT EXISTS project_shares_grantee ON project_shares (grantee);
