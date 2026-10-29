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
| `usage_daily` | the Usage page's totals: one row per day, person, client, route, model, served-by model and service. Person `''` is usage from before per-user tracking (`harness-usage.json` moves in once, the first time the table is empty). Counts are added by upserts about 2 s after each reply, so a restart loses at most the last couple of seconds. Migration `012` |

The chat page still works from the browser's storage and saves to Postgres about 1.5 s after each change, sending only the messages that changed and the version it last saw. If another device (or, later, the server) saved in between, the save is refused with a 409; the page pulls the chat, joins the two sets of messages by id (`ui/chatmerge.js`) and saves again, so neither side's messages are lost. At start it pulls what another device saved (the newer copy wins) and uploads chats this browser has that the server lacks. The server also keeps a reply for a page that went away mid-answer (`utils/chatReplies.js`, details in [Run it on Fly.io](fly.md)). Migration `003` split the earlier whole-chat rows into messages and left a safety copy in `chats_before_rows` (drop it once you are happy: `DROP TABLE chats_before_rows`).

## Continue with Google / GitHub

Set `NEON_AUTH_BASE_URL` and the login page offers the buttons in `OAUTH_PROVIDERS` (default `google`; Neon provides shared Google credentials for development, GitHub needs your own OAuth app in the Neon console, then `OAUTH_PROVIDERS=google,github`).

Sign-in is **invite-only**: an admin adds an email on the Users page, and only a verified provider email on that list can sign in. `HARNESS_ADMIN_EMAILS` lists emails that are admins without an invite. People who sign in this way get a normal user (created on first sign-in) and can make API keys for programs like Claude Code.

### Turning on GitHub sign-in

No code change is needed; the login page just needs the provider switched on, after Neon has one to talk to:

1. **GitHub OAuth App.** GitHub > Settings > Developer settings > OAuth Apps > New. Homepage URL: your `HARNESS_PUBLIC_URL`. Authorization callback URL: the one the Neon console shows for GitHub (it is your `NEON_AUTH_BASE_URL` followed by `/callback/github`; the harness's own address is not used here). Copy the Client ID and make a Client secret. This is a different app from the "Connect GitHub" App in [Run it on Fly.io](fly.md); sign-in only needs the default `read:user` and `user:email` access.
2. **Neon console.** Project > Auth > OAuth providers (or Settings) > GitHub: paste the Client ID and secret and enable it. The address people use must also be a trusted domain (below).
3. **Show the button.** `fly secrets set OAUTH_PROVIDERS="google,github"` (locally: `OAUTH_PROVIDERS=google,github` in `.env`). `fly.toml` leaves it unset on purpose so the button appears only once steps 1 and 2 are done.

The email GitHub reports must be verified and on the Users page invite list (or in `HARNESS_ADMIN_EMAILS`), exactly as with Google; a GitHub account with no verified email is refused.

The address people use must be trusted by Neon Auth: `neon neon-auth domain add https://your-host` (set `HARNESS_PUBLIC_URL` if the harness sits behind a proxy). `localhost` is trusted already.

## Each person's own tools, routings and settings

With logins on and a database, signed-in people who are not admins get their own copies of three things. Admins keep the install-wide ones.

- **MCP servers (Tools page).** A non-admin's Tools page lists and edits *their own* servers, stored encrypted in `user_mcp`. They can add **remote servers only** (HTTP or SSE): a stdio server is a program run on this machine, and the shell and repo tools run here too, so those stay admin-only. A non-admin's chat is offered only their own servers, never the admins' `mcp-servers.json`. Addresses that point at this machine or a private network (localhost, 10.x, 169.254.x, Fly's private network) are refused, and `${NAME}` references are not expanded for them, so a server entry can't read the host's secrets. This needs `ENCRYPTION_KEY` (`openssl rand -base64 32`); without it the page says so and nothing is stored. A name that resolves to a public address when saved and a private one later (DNS rebinding) is re-checked before each connection, but the connection does its own lookup, so treat this as a strong guard, not a sandbox.
- **Routings.** A non-admin sees the admins' routings (marked shared) and can add their own, which only name models already in `config.yaml`. Their own ride along on `x-harness-profile` and the Auto choice. Models, fallbacks and the Router stay admin-only.
- **Compression.** `GET/POST /ui/api/my/settings` lets a person switch the terse-output instruction, Headroom and the context anchor for their own requests on the default routing. Every other setting stays global.

The Routing page's editor still shows admin-only parts to a non-admin; the API is in place and the page for non-admins has not been adapted.

## Guests and bringing your own OpenRouter key

Two kinds of non-admin, both set up by an admin on the Users page (or by inviting an email with the role *Guest*). A guest can't be self-made.

- **Guest.** Uses the owner's key with a hard lifetime cap (default $1, `HARNESS_GUEST_CAP_USD`; not monthly). Before each request the worst case it could cost is *reserved* in one atomic SQL update (`credit_accounts`, `credit_holds`, `utils/credit.js`): input estimated pessimistically at 2 characters a token, output capped at `HARNESS_GUEST_MAX_OUTPUT` (4096), priced at the dearest model the Gateway might fall back to. If the credit can't cover that, the answer is a 429 and nothing reaches a model. When the reply ends the reservation becomes the real cost from the reply's token counts; a reply with no counts is charged the worst case, a failed call nothing, and a reservation nobody settled (a crash) is charged in full after 20 minutes. Guests get only models with a known price (free ones cost nothing); requests with no known price, and every request while the database is down, are refused. Fallbacks are limited to priced models.
- **Full user** (with `HARNESS_USER_CREDENTIALS=1`). Refused with a 402 until they press **Connect OpenRouter** on the Users page (or paste a key). Connecting uses [OpenRouter's OAuth PKCE flow](https://openrouter.ai/docs/guides/overview/auth/oauth): the browser goes to `openrouter.ai/auth` with an S256 challenge, comes back to `/ui/api/me/credential/callback`, and the harness trades the code at `POST /api/v1/auth/keys` for a key on the person's own account. The key is stored encrypted in `user_credentials` (`kind` `oauth`), and the callback address is `HARNESS_PUBLIC_URL` (https, or localhost). They can revoke it at openrouter.ai/settings/keys. Their requests carry a signed ticket (`utils/credentialTicket.js`) in `extra_headers`; the Gateway forwards it to the harness's `/openrouter-proxy`, which swaps in their key. **Key health:** OpenRouter's OAuth flow hands out a plain key with no refresh token, so the harness cannot renew it; it watches it instead. The Users page asks OpenRouter (`GET /api/v1/key`) and tells the person to press Reconnect when the key is refused, expired, expiring within a week (if `expires_at` is set) or out of limit. If OpenRouter answers 401 to one of their requests, the proxy flags the key and answers with a reconnect message instead of the raw error. **Keys the server issues (optional):** set `OPENROUTER_MANAGEMENT_KEY` (a server secret in `.env`; it can only create and delete keys) and an admin gets an **Issue key** button per full user on the Users page. The server then calls OpenRouter's [Management API](https://openrouter.ai/docs/guides/overview/auth/management-api-keys) (`POST /api/v1/keys`) for a key named `harness: <user>` with a spending limit (`OPENROUTER_USER_KEY_LIMIT`, default $5) and, if `OPENROUTER_USER_KEY_DAYS` is set, an expiry. The key is stored encrypted with its hash (`kind` `managed`). **These keys bill the owner's OpenRouter account.** A managed key that OpenRouter refuses, expires or is within a day of expiring is replaced automatically (new key saved first, then the old one deleted; at most once an hour per person; an hourly sweep checks them all). A key that merely hit its limit is not replaced, so the cap holds. Disconnecting deletes the key at OpenRouter too. Pasted and OAuth keys cannot be replaced by the harness; those people get the Reconnect prompt. **Your own main key:** also set `OPENROUTER_MAIN_KEY_RENEW=1` (and `LITELLM_MASTER_KEY`) and the server issues itself a key named `harness: main` (optional `OPENROUTER_MAIN_KEY_LIMIT` dollars and `OPENROUTER_MAIN_KEY_DAYS`), keeps it encrypted in the database (or `data/openrouter-main-key.json` without one), and swaps in a fresh one before it lapses or when OpenRouter refuses it, deleting the old one. The Gateway and Router reach OpenRouter through `/openrouter-proxy` in this mode, so they follow the swap without a restart. The key pasted in `.env` is never deleted by the harness (it does not know its hash): delete it at openrouter.ai once this works. They may use OpenRouter models only. The server refuses to start with this switched on unless logins, `DATABASE_URL`, `ENCRYPTION_KEY` and a proxy key are all set.

Before relying on this, check against a real LiteLLM that `extra_headers` in the request body reach the proxy: if the Gateway dropped them, a full user's request would run on the owner's key. The Router's Jev calls send no ticket, so they always use the owner's key.

Not tried against a real OpenRouter account: the flow is checked against a stand-in for `/auth/keys`. The pending sign-in (verifier) is held in memory for 10 minutes, so it needs one server machine, which is how the Fly app runs. Per-person workload identity federation (the harness as an OIDC issuer) was replaced by this; the owner's own install-wide federation (#90, `OPENROUTER_FEDERATION_POLICY_ID`) is unchanged.

## Sharing projects

Everything is private to the signed-in person: every query on chats, projects and settings filters on the owner, and `test/projectShares.test.js` checks that one user cannot read or write another's. A project is shared only when its owner says so, in the project's settings (Sharing):

- With named people (existing, non-guest accounts only), each **Can view** or **Can edit**, or with **everyone with an account** (view or edit). Sharing is stored in `project_shares` (migration 011).
- A shared project shows its name, colour, instructions and its chats, not its repo path or skills. The chats stay in the owner's rows; people with edit write into them, and a chat they start in the project is kept by the owner. Only the owner deletes chats or the project.
- Guests can neither share nor receive. Without logins (single user) there is no Sharing section.
- Taking a share back removes the project and its chats from the other person's browser at their next sync (within a minute).

### Another person on the same browser

The chat page keeps a working copy in the browser's localStorage, and a browser profile is shared by everyone who signs in on it. With a database, the page records whose copy it is (`harness-owner`) and clears it when a different account signs in, before anything is shown or uploaded (`ui/ownerScope.js`). A copy with no label (made before this existed) is claimed only if the account already has data; otherwise it is cleared. Without a database nothing is cleared, since that browser holds the only copy: use a separate browser profile per person.

## Attachments

Images and text files attached in chat are stored in the `attachments` table, apart from the chat text. The synced message keeps a stub (name, kind, size, id); the page uploads each file once (`POST /ui/api/sync/chats/:chat/attachments`) and a second device fetches the bytes only when it shows an image or sends the file to a model. A file over `HARNESS_ATTACH_MAX_MB` (default 6) or past `HARNESS_ATTACH_QUOTA_MB` (default 200 per person) stays on that device only, with a note. Deleting a chat deletes its attachments. Neon Free has 1 GB in all, so lower the quota if several people attach images.
