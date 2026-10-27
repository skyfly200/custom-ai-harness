# Chats and sign-in in Neon

Optional. With no `DATABASE_URL` the harness works as before: users and keys in `users.json`, chats in the browser. With one, they live in Postgres (Neon), so chats follow you between devices and sign-in survives a restart.

## Turn it on

1. Make a Neon project and run `neon init` and `neon deploy` in the repo (see `neon.ts`). That writes `DATABASE_URL` and `NEON_AUTH_BASE_URL` to `.env.local`, which the harness reads next to `.env`. On a server, put them in the host's secrets instead.
2. Use the **pooled** `DATABASE_URL` (host contains `-pooler`). Tables are created at start (`migrations/`), or run `npm run migrate`.
3. A host that only allows outbound port 443 (cloud sandboxes) can't reach Postgres on 5432: set `DATABASE_DRIVER=http` to use Neon's HTTPS driver.

## What is stored

| Where | What |
|---|---|
| `harness_store` | the Users store: users, API keys, invites |
| `sessions` | browser sessions (hash only) |
| `chats` | each chat's title, settings and the order of its messages, per user, with a version; delete leaves a marker so other devices drop it too |
| `chat_messages` | one row per message (the page's own message object), per chat |
| `user_data` | projects, skills, commands, schedules and chat preferences, per user; also the person's own routings (`routings`) and compression overrides (`settings`) |
| `user_mcp` | each person's own MCP servers, encrypted whole with `ENCRYPTION_KEY` |

The chat page still works from the browser's storage and saves to Postgres about 1.5 s after each change, sending only the messages that changed and the version it last saw. If another device (or, later, the server) saved in between, the save is refused with a 409; the page pulls the chat, joins the two sets of messages by id (`ui/chatmerge.js`) and saves again, so neither side's messages are lost. At start it pulls what another device saved (the newer copy wins) and uploads chats this browser has that the server lacks. The server also keeps a reply for a page that went away mid-answer (`utils/chatReplies.js`, details in [Run it on Fly.io](fly.md)). Migration `003` split the earlier whole-chat rows into messages and left a safety copy in `chats_before_rows` (drop it once you are happy: `DROP TABLE chats_before_rows`).

## Continue with Google / GitHub

Set `NEON_AUTH_BASE_URL` and the login page offers the buttons in `OAUTH_PROVIDERS` (default `google`; Neon provides shared Google credentials for development, GitHub needs your own OAuth app in the Neon console, then `OAUTH_PROVIDERS=google,github`).

Sign-in is **invite-only**: an admin adds an email on the Users page, and only a verified provider email on that list can sign in. `HARNESS_ADMIN_EMAILS` lists emails that are admins without an invite. People who sign in this way get a normal user (created on first sign-in) and can make API keys for programs like Claude Code.

The address people use must be trusted by Neon Auth: `neon neon-auth domain add https://your-host` (set `HARNESS_PUBLIC_URL` if the harness sits behind a proxy). `localhost` is trusted already.

## Each person's own tools, routings and settings

With logins on and a database, signed-in people who are not admins get their own copies of three things. Admins keep the install-wide ones.

- **MCP servers (Tools page).** A non-admin's Tools page lists and edits *their own* servers, stored encrypted in `user_mcp`. They can add **remote servers only** (HTTP or SSE): a stdio server is a program run on this machine, and the shell and repo tools run here too, so those stay admin-only. A non-admin's chat is offered only their own servers, never the admins' `mcp-servers.json`. Addresses that point at this machine or a private network (localhost, 10.x, 169.254.x, Fly's private network) are refused, and `${NAME}` references are not expanded for them, so a server entry can't read the host's secrets. This needs `ENCRYPTION_KEY` (`openssl rand -base64 32`); without it the page says so and nothing is stored. A name that resolves to a public address when saved and a private one later (DNS rebinding) is re-checked before each connection, but the connection does its own lookup, so treat this as a strong guard, not a sandbox.
- **Routings.** A non-admin sees the admins' routings (marked shared) and can add their own, which only name models already in `config.yaml`. Their own ride along on `x-harness-profile` and the Auto choice. Models, fallbacks and the Router stay admin-only.
- **Compression.** `GET/POST /ui/api/my/settings` lets a person switch the terse-output instruction, Headroom and the context anchor for their own requests on the default routing. Every other setting stays global.

The Routing page's editor still shows admin-only parts to a non-admin; the API is in place and the page for non-admins has not been adapted.
