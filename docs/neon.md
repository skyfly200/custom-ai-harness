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
| `user_data` | projects, skills, commands, schedules and chat preferences, per user |

The chat page still works from the browser's storage and saves to Postgres about 1.5 s after each change, sending only the messages that changed and the version it last saw. If another device (or, later, the server) saved in between, the save is refused with a 409; the page pulls the chat, joins the two sets of messages by id (`ui/chatmerge.js`) and saves again, so neither side's messages are lost. At start it pulls what another device saved (the newer copy wins) and uploads chats this browser has that the server lacks. Migration `003` split the earlier whole-chat rows into messages and left a safety copy in `chats_before_rows` (drop it once you are happy: `DROP TABLE chats_before_rows`).

## Continue with Google / GitHub

Set `NEON_AUTH_BASE_URL` and the login page offers the buttons in `OAUTH_PROVIDERS` (default `google`; Neon provides shared Google credentials for development, GitHub needs your own OAuth app in the Neon console, then `OAUTH_PROVIDERS=google,github`).

Sign-in is **invite-only**: an admin adds an email on the Users page, and only a verified provider email on that list can sign in. `HARNESS_ADMIN_EMAILS` lists emails that are admins without an invite. People who sign in this way get a normal user (created on first sign-in) and can make API keys for programs like Claude Code.

The address people use must be trusted by Neon Auth: `neon neon-auth domain add https://your-host` (set `HARNESS_PUBLIC_URL` if the harness sits behind a proxy). `localhost` is trusted already.
