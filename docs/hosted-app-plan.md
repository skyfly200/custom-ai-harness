# Plan: the harness as a hosted app with accounts

Written 2026-10-27 for Skyler. Updated the same day with Skyler's answers: invite-only users, OpenRouter workload identity federation as the main credential path with $1 guest accounts as the fallback, attachments as a separate goal from text chats, a Fly region near Colorado and a `skylerfly.com` subdomain. A plan, not code. It covers running the harness on [Fly.io](https://fly.io), keeping chats and per-user data in [Neon](https://neon.com) Postgres, and adding accounts with OAuth sign-in. Back to the [README](../README.md). Related: [Run it on a server](server-docker.md), [Named logins](logins.md), [Task runner](task-runner.md), the [agentic roadmap](../ROADMAP.md).

## Status (2026-10-27)

PR 2 (database layer), PR 4 (chats in Neon) and PR 5 (sign-in) shipped in [PR #98](https://github.com/skyfly200/custom-ai-harness/pull/98); see [Chats and sign-in in Neon](neon.md). They differ from this plan in three ways, and where the two disagree below, `neon.md` and the code are right:

- **Sign-in uses Neon Auth** (managed Better Auth) for the Google and GitHub buttons, invite-only, with `HARNESS_ADMIN_EMAILS` for admins. This plan recommended self-hosted OAuth; the managed option was chosen instead. Users, API keys and invites sit in `harness_store`, sessions in `sessions`.
- **Chats are stored as the page keeps them**, one row per chat in `chats` (plus `user_data` for projects, skills, commands, schedules and prefs), not one row per message. The staged move to message rows is in [Moving chats to message rows](#moving-chats-to-message-rows). The browser still works from localStorage and syncs about 1.5 s after each save. A message-per-row table and server-side message saving are not done.
- **`DATABASE_DRIVER=http`** (Neon's HTTPS driver) exists for hosts that only allow port 443.

**Fly deploy (PR 3) and the Stop button with idle sleep (3a) are built; next is a real deploy to `agents.skylerfly.com`.** `fly.toml` and a Fly Dockerfile don't exist yet. Still not done: 3a (Stop button and idle stop), 6 to 11.

## The short version

- **Fly:** one app, one Machine at first (shared-cpu, 1 GB, about $6.70 a month), running Gateway, Router and Interceptor from one image under the existing `npm run all` launcher. Fly gives https, so the Cloudflare tunnel is not needed. A 1 GB volume holds only the global `config.yaml` and settings. Split into one Machine per part only when memory or restarts make it worth it.
- **Neon:** holds everything that belongs to a person: accounts, sessions, API keys, chats, messages, projects, routings, settings, MCP servers, usage and limits. The app uses the pooled connection string; migrations use the direct one. The Free plan is enough to start; chat attachments are the thing that will outgrow it.
- **Accounts:** keep what already exists (named logins, `hk_` API keys, per-address rate limits) and add "Sign in with GitHub / Google" on top. Recommendation: do **not** adopt WorkOS AuthKit yet. Build GitHub and Google sign-in with a small OAuth library behind an interface, and revisit AuthKit if you want public sign-up, MFA or company SSO. Reasons are in [Auth choice](#auth-choice).
- **Local use keeps working.** With no `DATABASE_URL`, the harness behaves as it does today (files, localStorage). The hosted features switch on with environment variables, the same pattern as `HARNESS_REQUIRE_LOGIN`.
- **Order:** database layer, Fly deploy (usable right away with the current named logins), chats in the database, OAuth, per-user settings, usage limits, per-user OpenRouter keys (then keyless federation), attachments, then Runs. Details in [PR order](#pr-order).

## What exists today (and what it means for hosting)

| Piece | Today | Hosting consequence |
|---|---|---|
| Interceptor `server.js` (Node/Express, :3000) | Serves UI, `/ui/api/*`, `/v1/*`; picks models; the only published port | The app that gets the public address |
| Gateway (LiteLLM, :4000) and Router (Python, :6060) | Internal only; Gateway reads `config.yaml`, Router reads `routellm-config.yaml` | Stay private on the Machine's loopback or Fly's private network |
| Logins | `utils/users.js` + `utils/login.js`: scrypt passwords, `HARNESS_ADMINS` from env, other users and `hk_` keys in `users.json` behind a `Store` interface, in-memory sessions | The `Store` interface is already the seam for Postgres. In-memory sessions are lost on every deploy and cannot be shared by two Machines, so sessions move to the database |
| Chats | Browser localStorage: `harness-chats` (index), `harness-chat:ID`, `harness-chat-prefs`, `harness-projects`, `harness-skills`, `harness-commands`, `harness-schedules` (`ui/chat.js`) | The main thing to move. They are per browser today, so a phone and a laptop see different chats |
| Settings, routings, usage | JSON files: `harness-settings.json`, `routing-profiles.json`, `harness-usage.json`, `mcp-servers.json` (paths via `HARNESS_*_FILE`), global for the whole install | Need an owner. Some stay global (model list, Router backend), some become per user |
| Task runner | Separate process `runner/` on :3100, run records and worktrees in `runs/`, repos in `repos/`, E2B for commands | Run records move to Postgres; repos come from GitHub, not a folder |
| Docker | `docker-compose.yml` with three images (harness, router, gateway), optional runner, ollama, tunnels; measured about 425 MB RAM | Reuse the images' contents; Fly has no compose, so the layout is described below |

**Not viable on Fly (as before):** the local `:8000` engine and Ollama. Strong requests go to OpenRouter models, as the server docs already describe. `HARNESS_MODE=laya` or `routellm` need 2 GB or more and are not worth it here; Jev through OpenRouter stays the default.

## Auth choice

What the harness needs from auth, in order of importance:

1. Browser sign-in for a handful of people, with GitHub and Google.
2. **Programs** (Claude Code, other apps) signing in with a long-lived key. No hosted login page can do this; the existing per-user `hk_` keys stay and are made in the app.
3. Admins who manage users, and a way to turn sign-up on or off.
4. Works with the Node Interceptor and keeps working on a laptop with no internet identity service.

| Option | Cost | Lock-in | Fit with this Node Interceptor | Notes |
|---|---|---|---|---|
| **Keep named logins only** (`HARNESS_REQUIRE_LOGIN`) | $0 | None | Already built | No OAuth, no self-sign-up. Fine for 1 to 3 people; fails the "sign in with my Google account on any phone" ask |
| **Self-hosted OAuth in the Interceptor** (a small library such as Arctic for the GitHub and Google code exchange, or Better Auth if you want a fuller toolkit; sessions and identities in Neon) | $0 | Low: your own tables; the library is replaceable | Good. A few routes (`/auth/github`, `/auth/github/callback`) next to `utils/login.js`, which already has cookies, rate limits and API keys | You own security details: state and PKCE, session fixation, cookie flags. Those are well-trodden and `login.js` already does the cookie parts. Lucia was retired as a library, so don't pick it |
| **Auth.js** | $0 | Low | Awkward: built around Next.js and similar; Express support exists but is the less-used path | Not recommended for a plain Express app |
| **WorkOS AuthKit** (hosted login page, Node SDK) | Free for the first 1M monthly active users, then $2,500 a month per extra million; a custom login domain is $99 a month; SSO is $125 per connection per month (only if a company wants SAML) ([WorkOS pricing](https://workos.com/pricing.md)) | Medium: users and identities live at WorkOS (you can store a mirror), sign-in pages are theirs, switching means re-linking every account | Fine technically: redirect, callback, a sealed session cookie. But you still need your own `users`, `hk_` keys and limits, so it replaces only the "log in with X" part | Worth it for MFA, magic links, passkeys, enterprise SSO, or public sign-up with email verification without writing any of it |
| Clerk, Auth0, Supabase Auth, Stytch | Similar free tiers, different caps | Medium to high | Similar to AuthKit | Not compared in depth; same trade-offs |

**Recommendation.** For a personal harness shared with a few people, cost is not the deciding factor (AuthKit is free at this size). Lock-in and moving parts are. Self-hosted GitHub and Google sign-in is about 300 lines, needs no outside account to run locally, and fits the code that exists. It also gives the **GitHub token** the Runs feature wants later (to clone and push branches), which is a reason to make GitHub the first provider.

Put the choice behind a small interface, `identify(req) -> { userId, email, name }`, and keep the `users` and `identities` tables ours. Then AuthKit becomes "one more provider" if you want it later, not a rewrite. Choose AuthKit now instead if you expect strangers to sign up, or want MFA or passkeys without writing them.

Admin bootstrap: keep `HARNESS_ADMINS` (password admins) and add `HARNESS_ADMIN_EMAILS` / `HARNESS_ADMIN_GITHUB` so your own OAuth login is an admin from the first start. Everyone else is **invite-only** (decided): an admin adds an email or GitHub name on the Users page, and only invited people can finish sign-in. There is no open sign-up setting in v1.

## Fly.io layout

Fly runs a Docker image as a Machine (a small VM) with https in front. It has no free tier for new organisations, only a short trial ([Fly pricing](https://docs.fly.io/about/pricing)). Prices used here, from that page: shared-cpu-1x with 1 GB is $6.70 a month, with 512 MB $3.69; volumes $0.15 per GB-month; outbound traffic $0.02 per GB in North America and Europe, inbound free.

### v1: one Machine, one image

- One image with Node, the Python venv (LiteLLM and the Router), started by `scripts/start-all.js`, which already starts all three in order from one window. Memory was measured at about 425 MB, so **shared-cpu-1x / 1 GB** fits with room for a few chats; 512 MB is too tight.
- Only the Interceptor listens on the public port (`internal_port = 3000`); Gateway and Router bind to 127.0.0.1 inside the Machine. No private-network wiring, no shared secrets between Machines, no cross-Machine latency.
- **Sleeps when idle at first** (Skyler's ask, 2026-10-27; see [Start and stop to save cost](#start-and-stop-to-save-cost)). Once schedules and keep-alive pings run on the server (PR 10) it should stay on, with `min_machines_running = 1`.
- One region, close to Skyler. Fly's Machines are per region; Neon's region should be the same one (or nearest), because every chat save is a database round trip.
- **Why not three Machines now?** Fly can run Gateway, Router and Interceptor as separate Machines (separate apps or process groups, talking over the private `.internal` network). That gives independent restarts, which matters because a model-list change needs a Gateway restart (the Routing page notes this). It costs about 3x the base price and adds three more places for things to go wrong. Do it when the Gateway restart is a real annoyance or memory grows.
- One Dockerfile for Fly is a new file; the compose images stay for self-hosting.

### Volumes

- **One 1 GB volume at `/app/data`** ($0.15 a month). It holds the files that are *global to the install* and edited by admins: `config.yaml` (Routing page writes it via `utils/gatewayConfig.js`), `routellm-config.yaml`, `harness-settings.json`, and a copy of anything not yet in Neon.
- Machine disk outside the volume is thrown away on every deploy; that is why per-user data goes to Neon and not the volume.
- A volume lives on one host and does not fail over. Fly takes daily snapshots (first 10 GB free). Because the volume holds only config that can be rebuilt from the repo, losing it is an annoyance, not a disaster.
- Later option: move the global config into a Neon table and drop the volume entirely, which allows two Machines. Not needed for v1.

### Secrets and configuration

`fly secrets set ...` (never in the image or `fly.toml`):

| Secret | Used for |
|---|---|
| `DATABASE_URL` (pooled), `DATABASE_URL_DIRECT` (migrations) | Neon |
| `SESSION_SECRET` | Signing session cookies |
| `ENCRYPTION_KEY` | Encrypting per-user secrets in the database (MCP env values, users' own provider keys) |
| `OPENROUTER_API_KEY` or the federation settings from PR #90 | Model access |
| `LITELLM_MASTER_KEY` | Interceptor to Gateway (internal) |
| `GITHUB_CLIENT_ID/SECRET`, `GOOGLE_CLIENT_ID/SECRET` | OAuth |
| `HARNESS_ADMINS` or `HARNESS_ADMIN_EMAILS` | Bootstrap admin |
| `RUNNER_TOKEN`, `E2B_API_KEY` | Runs, later |

Non-secret settings (`HARNESS_MODE`, `STRONG_MODEL` and the other `.env` launch settings from PR #47) go in the `[env]` block of `fly.toml`. Setting them there means they win over the dashboard at start, as documented.

### Region and domain

- **Fly region.** Skyler is in Colorado. Fly has no Denver region (checked at deploy time, 2026-10-27), so the app uses Dallas (`dfw`). Fly prices differ by region and the figures above are for `iad`/`ewr`, so check the Machine price for `dfw`.
- **Neon region.** Neon has no Denver; the nearest AWS regions are `us-west-2` (Oregon) and `us-east-2` (Ohio). Pick one and keep the app in a region with a short round trip to it (every chat save is a database call). I'd choose Oregon, then measure a query from the Machine and switch if it is slow.
- **Domain.** Use a subdomain such as `agents.skylerfly.com`. With DNS on Netlify: (1) `fly certs add agents.skylerfly.com` and read the DNS records it asks for; (2) in Netlify DNS add a `CNAME` for `harness` pointing at the app's `YOUR-APP.fly.dev` (Fly may also ask for an `_acme-challenge` CNAME, or an `A`/`AAAA` pair if you prefer); (3) wait for `fly certs check` to show the certificate issued. No Netlify hosting is involved, only its DNS.
- This one address is used everywhere that needs a stable name: the OAuth callbacks (`https://agents.skylerfly.com/auth/github/callback`), the OIDC issuer URL for OpenRouter federation (OpenRouter requires the token's `iss` to equal it exactly, https only), and the PWA install.
- Pick the final subdomain before registering the OAuth apps and the OpenRouter issuer, since both store the address. Changing it later means redoing both.

### Start and stop to save cost

Asked for on 2026-10-27: let the UI start and stop the Fly server so it costs nothing while unused.

**What a stopped Machine costs.** Per [Fly's pricing page](https://docs.fly.io/about/pricing), Machines are billed by the second while running, so a stopped one adds no CPU or memory charge. The volume ($0.15 a month per GB) is billed even when the Machine is stopped. I did not confirm whether Fly also bills stopped Machines for their root disk; check the invoice after a week. Neon already sleeps by itself, so nothing to do there. Used a few hours a day, the Machine cost drops from about $6.70 to roughly $1 to $2 a month.

**The catch.** A button in the harness UI can't start the harness, because when the Machine is stopped there is no UI to click. Starting has to come from somewhere that is always on. Three ways, in the order I'd do them:

1. **Fly starts it for you (recommended first step).** Fly's proxy can start a stopped Machine when a request arrives and stop it again after it has been idle for a while (`auto_start_machines = true`, `auto_stop_machines = "stop"`, `min_machines_running = 0` in `fly.toml`). Opening the app's address on your phone, or a request from Claude Code, is the start button. No new code and no extra service. The first request waits while the Machine boots and LiteLLM starts; I'd guess 10 to 30 seconds, not measured, so the first Claude Code call may need a retry.
2. **A Stop button in the UI.** An admin-only "Stop server" on the Dashboard, with a confirm. It asks Fly's Machines API to stop this Machine, which needs a Fly token as a secret (`fly tokens create deploy` limited to this app). The page shows "stops itself after N idle minutes" (`HARNESS_IDLE_STOP_MIN`, off by default). The app, not Fly's proxy, decides when it is idle, because it knows things the proxy can't: a streaming reply, a Run in progress, or an unanswered approval keep it awake. It refuses to stop (and says why) while any of those exist. Fly's own idle stop stays on as a backstop only if the app's own check is off.
3. **A Start button on an always-on page (only if 1 feels clumsy).** A tiny separate page, for example on Cloudflare Pages or Vercel's free tier, that signs you in (GitHub, your login only) and calls the Machines API to start the Machine, then shows its status and forwards you when it is up. It holds the Fly token, so it must never run in the browser. This is a second thing to host and secure, so only build it if opening the address is not good enough.

**What doesn't work while it sleeps:** schedules, keep-alive pings, anything that must happen with no one there. Show a plain note on the Schedules page ("runs only while the server is awake") until PR 10 moves them to the server and the Machine stays on. Chat history is safe either way because it lives in Neon.

**Safety:** the Fly token can start, stop and delete Machines in that app, so it lives only in `fly secrets`, is scoped to one app, and the Stop route is admin-only and logged. Auto-stopping during a deploy is not a problem; `fly deploy` starts the Machine.

### Traffic, https and headers

- Fly terminates https and forwards with `X-Forwarded-For` / `Fly-Client-IP`. `utils/access.js` already treats proxied requests as non-local, so the local-only controls never open to the internet. Needed changes: `app.set('trust proxy', 1)` so rate limits key on the real client address and cookies get `Secure`, and `force_https = true`.
- Streaming (SSE and long model replies) works through Fly's proxy; the existing 5-minute gateway timeout and 2-minute idle stream timeout stay below Fly's own idle limits. Test with a long reply early (not verified here).
- Health check: use the existing status route; fail the deploy if the Gateway does not answer.
- Deploy: `fly deploy`, with a `release_command` that runs migrations. Optional GitHub Action on merge to `master`.

### Rough monthly cost

Fly Machine about $6.70 if left running all month (much less if it sleeps; see above) + volume $0.15 + traffic (outbound is billed, and that includes every request the Machine forwards to OpenRouter; Claude Code requests are 100 KB to 1 MB each, so heavy use is a few GB a month, about $0.02 per GB) = **about $7 to $9**. Neon Free: $0. Auth: $0. Model spend on OpenRouter is the real cost and is the reason for per-user limits below. I did not check the price of a dedicated IPv4 address; a shared one is free per Fly's page.

## Neon

- **Plan.** Free gives 100 compute-hours per project, 1 GB storage per project, scale-to-zero after 5 minutes that cannot be turned off, and 5 GB of egress ([Neon pricing](https://neon.com/pricing)). Launch is pay-as-you-go: $0.106 per compute-hour, $0.35 per GB-month, scale-to-zero optional. Chat text is tiny; start on Free.
- **What will outgrow 1 GB:** chat attachments (images and files in base64). Decided: attachments are a **separate goal** from text chats. The chats PRs store text, tool calls and metadata only; messages with attachments keep a placeholder (name, type, size) and, until the attachments PR lands, the attachment bytes stay in the browser as today. The attachments PR then adds object storage (Fly's Tigris, or any S3-compatible bucket), a `attachments` table (owner, key, size, type), uploads by signed URL, and a size limit per user.
- **Scale-to-zero.** After 5 idle minutes the database sleeps, and the next query waits for it to wake. Acceptable for a personal app. The app must retry the first connection once and never hold a connection open across idle time. Launch plan with scale-to-zero off removes this if it annoys.
- **Connections.** Use the pooled connection string (the host with `-pooler`) for the app, with a `pg` Pool of 5 to 10; use the direct string only for migrations and long-lived `LISTEN`. With pooling in transaction mode, don't rely on session state (`SET`, advisory locks held across requests, prepared statements the driver names itself). I did not find Neon's exact connection limit on its pricing page; read its docs before setting the Pool size.
- **Migrations.** Plain SQL files in `migrations/`, `npm run migrate`, a `schema_migrations` table. Run from Fly's `release_command`. No ORM needed; keep `pg` and a thin `utils/db.js`.
- **Branching** (Neon feature): a branch per PR is a cheap way to test migrations. Optional.
- **Backups.** Neon keeps short point-in-time history on Free. Add a scheduled `pg_dump` to a bucket later if the chats matter.

## Data model

**Shipped in #98 (what the database holds today):** `harness_store(name, data jsonb)` for users, keys and invites; `sessions(id_hash, name, expires)`; `chats(owner, id, title, project, updated bigint, data jsonb, deleted_at)`, one row per chat holding the whole chat object the page keeps, with `owner` the user's *name*; `user_data(owner, key, value jsonb, updated)` for projects, skills, commands, schedules and prefs. Newer wins by the page's own millisecond clock (a stale copy gets a 409). The sketch below is the **target** shape; [Moving chats to message rows](#moving-chats-to-message-rows) is the plan for getting from one to the other, in steps, only as far as is needed.

All ids are UUIDs (or ULIDs, so they sort). Times are `timestamptz`. Every user-owned row has `user_id` and every query filters on it.

```sql
users        (id, name, email, role 'admin'|'user', disabled, created_at)
identities   (id, user_id, provider 'github'|'google'|'password'|'workos', subject, email,
              password_hash null, access_token_enc null, created_at)   -- unique(provider, subject)
sessions     (id_hash, user_id, expires_at, created_at, last_seen, user_agent)
api_keys     (id, user_id, name, key_hash, last4, last_used, created_at, revoked_at)  -- the hk_ keys

projects     (id, user_id, name, system_prompt, settings jsonb, updated_at)
chats        (id, user_id, project_id null, title, settings jsonb,   -- routing choice, effort, mcp on/off, repo link
              pinned, created_at, updated_at, deleted_at null)
messages     (id, chat_id, seq, role, content jsonb,                 -- text parts, tool calls, attachment placeholders
              meta jsonb,                                            -- model, routing, tokens, cost, request id
              created_at)                                            -- unique(chat_id, seq)
skills       (id, user_id, kind 'skill'|'command'|'schedule', name, body jsonb, updated_at)

user_settings   (user_id, prefs jsonb)                    -- what is in harness-chat-prefs today
user_routings   (id, user_id, name, body jsonb)           -- routing-profiles.json, per user
user_mcp        (id, user_id, name, config jsonb, secrets_enc bytea)  -- mcp-servers.json, per user

usage_events (id, user_id, key_id null, at, day, client, model, served_by, provider,
              input_tokens, output_tokens, cached_tokens, cost_usd, route jsonb)
user_limits  (user_id, monthly_usd, daily_usd null, rpm null, allowed_models text[] null, byo_key_enc null)

runs         (id, user_id, status, goal, workflow, repo, branch, sandbox, cost jsonb, created_at, finished_at)
run_events   (run_id, seq, kind, body jsonb)              -- later
```

Notes:

- **Why `messages` as rows, not one JSON blob per chat.** A long chat (hundreds of turns, tool output) as one blob is rewritten on every save. Rows allow append-only writes and loading the last N messages. Message `content` stays JSON, so the chat page's current message objects map across with little change.
- **Editing and retry.** Today a retry may rewrite the last messages. Handle with `seq` plus `deleted`/`superseded` flags or by truncating `seq > n` in one transaction; decide when writing the chat PR.
- **Global data stays out of these tables:** the model list, Router backend and fallbacks (`config.yaml`), model stats. Admins edit those; users only choose among them.
- **Usage rows replace `harness-usage.json`'s daily roll-up.** Keep a materialised daily roll-up (view or table) so the Usage page stays fast.
- **Secrets at rest.** `*_enc` columns use AES-256-GCM with `ENCRYPTION_KEY`. API keys and session ids are stored only as hashes, as `users.js` does now.

## Chats: from localStorage to the database

1. **API.** `GET /ui/api/chats` (list with title, updated_at, no bodies), `GET /ui/api/chats/:id?before=seq` (page of messages), `PUT /ui/api/chats/:id` (title, settings), `POST /ui/api/chats/:id/messages` (append), `DELETE`. All scoped to the signed-in user; the existing Markdown export becomes a server route too.
2. **Where messages are saved.** The Interceptor already sees every request and reply and tags them with `x-harness-request-id`. The page sends a `chat-id` and the user message, and the server writes the user message *before* forwarding and the assistant message *when the stream ends* (and every few seconds while streaming, so a refresh mid-reply loses little). That makes a chat survive the page closing mid-answer, which localStorage cannot do. The browser keeps a small cache of the open chat for speed.
3. **Two devices.** Last write wins per chat settings; messages only append, so two devices don't clobber each other. Opening a chat checks `updated_at` and refreshes. No live push in v1; the existing SSE feed can carry a "chat changed" event later.
4. **Offline and local mode.** With no `DATABASE_URL`, the page keeps using localStorage exactly as now (`ui/chat.js` gets a `ChatStore` with a localStorage implementation and an API implementation, same methods). The local install loses nothing.
5. **Migration.** A one-time **Import from this browser** button on first sign-in: reads `harness-chats`, `harness-chat:*`, `harness-projects`, `harness-skills`, `harness-commands`, `harness-schedules` and `harness-chat-prefs`, POSTs them in batches, shows progress, and marks them imported (does **not** delete localStorage; offers "clear local copy" afterwards). Big chats go one at a time to stay under request size limits. Also add **Export all** as JSON (Markdown export exists per chat), so a user can always take their data out.
6. **Device-only preferences stay in localStorage:** zoom, layout, background, which chat is open, and similar (`bright-*`, `harness-chat-open`). Settings that should follow the person (default routing, voice, effort) go to `user_settings`.
7. **Schedules and keep-alive pings** (they need stage 2 of [Moving chats to message rows](#moving-chats-to-message-rows)) currently run in the open browser tab. In a hosted app they should run on the server (a timer in the Interceptor reading `skills` rows of kind `schedule`), or they stop whenever the tab closes. Treat as a follow-up; it is the main "works anywhere" gain after chats.

## Moving chats to message rows

**Update 2 (2026-10-27): stage 2 is built too** (the server saves a reply, text only, when the page goes away mid-answer; the Stop button and 30-minute idle sleep are built as well). Still open from this section: a stable user id instead of the name as chat owner, paging long chats, and server-side saving for tool-using replies and for schedules, Agents and Runs writing into chats.

**Update (2026-10-27): stages 1, 3 and 4 are built** (migration `003`, delta sync with join-on-conflict, no whole-chat blob), with almost nothing to migrate so the stages went out as one PR. **Stage 2 (the server saving replies itself) is not built yet** and is the next piece; schedules, Agents and Runs depend on it. The user id (stage 1's last part) is also still to do. The rest of this section is the original plan.

Skyler asked (2026-10-27) for a plan to move the storage to the message-rows model above, or to update this plan to the shipped one. The doc now does both: the shipped model is described as current, and this section is the staged path to rows. **Recommendation: keep whole-chat rows for now and move in stages, starting only when something needs the server to write messages** (stage 2). Nothing here changes the page for anyone until stage 3.

**What whole-chat rows cost today (all real, none urgent):**

1. **Every save rewrites the whole chat** (about 1.5 s after a change). A long chat with tool output and, until the attachments PR, images is megabytes per save, which spends Neon compute and egress for no reason.
2. **Two devices can lose work.** Newer-wins is per chat: a stale tab's save is refused (409), and a newer save from another device replaces messages the first one added.
3. **Only the browser saves.** Close the tab mid-reply and the reply is gone; the server never wrote it. Server-side schedules (PR 10), persistent Agents linked to chat projects, and Runs reporting back into a chat all need the server to append messages, which the whole-chat model can't do safely (two writers, one document).
4. **No per-message facts on the server** (model, tokens, cost), which per-user limits and the guest cap can get from `usage_events` instead, so this one is not a blocker.
5. **`owner` is the user's name**, not a stable id. As far as I can see users have only a name today, so renaming or removing and re-adding one would orphan or hand over chats. Fix when adding ids.

**Why not move at once:** whole-chat sync works, is tested against Neon, and matches the local-storage format, so local mode and the Markdown export stay trivial. A big-bang rewrite of `ui/chat.js` sync plus a data migration is the riskiest change in this plan.

**Stages** (each shippable alone, each reversible until stage 4):

| Stage | Change | Done when |
|---|---|---|
| 1. Add tables | Migration `003`: `chat_messages(owner, chat_id, seq, id, role, content jsonb, meta jsonb, created_at, revised_at, deleted_at)` with unique `(owner, chat_id, id)`; `chats` gains `version`; a stable `user_id` is added to users and `owner` is mapped to it. Backfill splits each stored `chats.data.messages` into rows. Whole-chat `data` keeps being written, so nothing reads the new table yet | Backfill row counts match message counts per chat; run it first on a Neon branch of production, not on production |
| 2. Server writes messages | The page sends `x-harness-chat-id` and a message id on each request. The Interceptor writes the user message before forwarding and the assistant message when the stream ends (and every few seconds while it streams), by message id so the page's own save and the server's never double up. Schedules, Agents and Runs can now append with the same call | A reply finishes and appears on another device with the first tab closed |
| 3. Page syncs deltas | `GET /ui/api/sync/chats/:id?after=seq` and message upserts by id replace whole-chat pushes; chat settings and title stay last-write-wins on `version`. The page keeps localStorage as its cache. Behind `HARNESS_CHAT_ROWS=1` so it can be switched off | Two devices add messages to one chat without losing either; long chats save only what changed |
| 4. Stop writing the blob | Drop `data.messages` from new saves (keep the column and the last full copy for one release), load the last N messages first and the rest on scroll | Export all still round-trips; old chats open unchanged |

**Edits and retries.** A retry or edit replaces the tail of a chat. Stage 2 marks replaced messages `deleted_at` and appends the new ones with higher `seq`, in one transaction, so history stays and the page shows the live branch. If branches turn out to matter, add `parent_id` later; don't build it now.

**Safety:** an Export all (JSON) before stage 1 goes live on production; stage 1 tested on a Neon branch; the whole-chat copy keeps being written until stage 4, so rolling back to it is a flag change. Local mode (no `DATABASE_URL`) is untouched at every stage.

**Where it sits in the PR order:** stage 1 and 2 as PR 4b, right after the Fly deploy and Stop button; stage 3 and 4 as PR 4c. PR 10 (server-side schedules) must come after stage 2.

## Per-user settings, routings and tools

Split every file-backed setting into **global (admin)** or **per user**:

| Setting | Becomes |
|---|---|
| Model list, fallbacks, Router backend and thresholds, Gateway keys, model stats | Global, admin only (stays in files on the volume) |
| Interceptor settings (compression, guard on/off) | Global default plus per-user override where it makes sense (compression yes, guard thresholds admin only) |
| Routings (`routing-profiles.json`) | Per user rows that point at global models. Users can't add models to the Gateway, only choose among the allowed ones. Admin routings can be marked "shared" so everyone sees them |
| Chat prefs, projects, skills, schedules | Per user (see chats) |
| MCP servers (`mcp-servers.json`) | Per user, with secrets encrypted |

**Security point that needs a decision (MCP and shell).** Today a chat can start MCP servers as local `npx`/stdio commands and, on the PC, a PowerShell session (`utils/mcp.js`, `utils/powershellSession.js`, `utils/chatShell.js`, `utils/repoTools.js`). On a shared Machine, a non-admin who can define a stdio MCP server can run any command in the container, with access to the Machine's secrets. For hosted mode:

- Non-admins may add only **remote (HTTP/SSE) MCP servers**. Stdio servers and shell tools are admin only, or off by default (`HARNESS_HOSTED=1` sets that).
- The read-only repo link uses `/repos`, which doesn't exist on Fly; replace with a GitHub-backed version (Runs section) or hide.
- The command guard keeps applying to tool calls as it does now.

Request handling: the Interceptor already reads `x-harness-profile` and similar headers. It adds the signed-in user to each request context and loads that user's routing instead of the file. The `Auto` routing choice (PR #70) only considers that user's routings.

## Per-user API key and cost limits

- **Who pays (decided: bring your own).** Each person supplies their own OpenRouter credential; the shared key is only the admin's own. Two kinds, stored per user:
  1. **A static OpenRouter key**, pasted in Account settings, encrypted with `ENCRYPTION_KEY` (`user_limits.byo_key_enc`). Works for anyone, including personal OpenRouter accounts.
  2. **Workload identity federation (WIF)**, which stores no secret. Facts from [OpenRouter's WIF page](https://openrouter.ai/docs/guides/overview/auth/workload-identity-federation): it is for Business and Enterprise organisations only; an org admin creates a *policy* (trusted issuer, audience, subject or CEL condition) that "acts as" one workspace API key owned by that org; the workload exchanges a signed JWT for a token that lasts up to 15 minutes; usage is billed to that key as if it were used directly. Personal accounts can't use it, and the page describes no spend cap on the policy itself, so limits come from the target key.
- **How WIF would work for hosted users.** PR #90 already does the exchange for one install-wide policy (`utils/openrouterAuth.js`, Gateway and Router go through `/openrouter-proxy`). Per user it needs two additions: (a) the harness becomes a small **OIDC issuer** (publishes `/.well-known/openid-configuration` and a JWKS, signs ES256 or RS256 JWTs with `iss` = the app's https address, `sub` = the user id, `aud` = the policy's audience), and (b) the user (or you, for your own org) adds the harness as a trusted issuer in OpenRouter and creates a policy with `sub` = their user id, then pastes the **policy id** into Account settings. Nothing secret is stored; revoking is pausing the policy. The Interceptor mints the JWT, exchanges it (cached for about 14 minutes, as #90 does) and uses the resulting token for that user's requests.
- **Wiring.** Today the Gateway and Router reach OpenRouter through `/openrouter-proxy` with one proxy key. Hosted mode makes that proxy per-request: the Interceptor tags each internal call with the signed-in user (an internal-only header the Gateway cannot be tricked into sending from outside, because the proxy is on the loopback or private network) and the proxy swaps in that user's key or exchanged token. If the user has no credential, the request is refused with a plain message, or falls back to the shared key when the admin allows it for that user.
- **Guest accounts (decided 2026-10-27).** Someone with no credential of their own is not refused: an admin (only an admin, never self-service) can create a **guest** user. A guest uses your shared key but has a hard **$1 lifetime cap** (not monthly; the credit does not renew), and is limited to cheap models (an allowed-model list on the account; the Frontier tier is off). The Interceptor checks the cap before forwarding, as for other limits; once spent, requests get a plain 429 saying the guest credit is used up, and you can raise it on the Users page. Users who are not guests and have no credential are refused with a message to add one. **No overshoot (Skyler, 2026-10-27):** the guest cap is enforced by reserving money before the request goes out, not by counting afterwards. See [Hard caps](#hard-caps-no-overshoot).
- **Decided (2026-10-27):** full users bring their own credential, so a full user needs their own OpenRouter Business org for federation, or (PR 8b, optional) a pasted key. Guests use Skyler's key. One policy per person in Skyler's org was considered and dropped.
- **Verify before building:** the exact JWT and issuer rules above come from OpenRouter's docs as read today; nothing has been tried against a real org. Test with one issuer, one policy and one key before designing the UI.
- **Programs.** Each user makes `hk_` keys on the Users page (exists). The key identifies the user, so Claude Code traffic counts against the same limits as chat. Keys can be named, revoked, and show last-used time (adding columns to what `login.js` has).
- **Metering and limits still apply.** Even with their own key, the harness records spend per user so people (and you) can see it, and an optional admin-set cap per person still stops requests with a 429. A person's own OpenRouter key limits are theirs to set on OpenRouter.
- **Metering.** `utils/usage.js` already reads real token counts from replies and `utils/modelInfo.js` has prices. Write one `usage_events` row per request with `user_id` and cost. Cost in USD is the common unit for limits.
- **Limits enforced before forwarding.** A middleware looks up `user_limits` and the user's month-to-date spend (a cached sum, refreshed on each event write) and answers `429` with a plain message when over. Controls: monthly and daily dollars, requests per minute, allowed models or tiers (for example no Frontier tier), max output tokens. Admins see all users on the Usage page and set limits there.
### Hard caps (no overshoot)

Counting spend after a request finishes lets parallel or long requests pass the cap. Guest credit (and any other cap an admin marks hard) instead works like a card pre-authorisation:

1. **Reserve first.** Before forwarding, the Interceptor computes the worst case for this request: input tokens (a deliberately high estimate, for example bytes divided by 2, so it never undercounts) times the model's input price, plus the output limit times the output price. The output limit is the request's `max_tokens`, lowered to what the remaining credit can afford, and set to a default if the client sent none.
2. **Atomic check.** One SQL statement adds the amount to `reserved` only if `spent + reserved + amount <= cap`, so two requests at once can't both squeeze in. If it fails, the request is refused with a plain 429 ("guest credit used up") and nothing reaches the model.
3. **Settle after.** When the reply ends, the real cost (OpenRouter's reported cost when present, else tokens times price) is added to `spent` and the reservation is released. If the connection drops or the usage never arrives, the full reservation is charged, because the real cost is unknown.
4. **Guests only get models with known prices.** A model the harness has no price for is off for guests, since a reservation can't be computed. Tool-using models are fine; reasoning models are included because their reasoning tokens count against `max_tokens`.
5. **Fails closed.** If the database is unreachable, a hard-capped user's request is refused rather than allowed.

Cost: a few more tokens of headroom held per request (a fraction of a cent on cheap models), and a database write before and after each guest request. The same mechanism can back a hard monthly cap for anyone else if you want one; the default for normal users stays a soft cap.

- **Known limits of this design.** Normal users' limits are soft: spend is counted after a request finishes, so concurrent requests can pass the limit by one request's worth. Guest credit is the hard kind (above). A single huge streaming reply can't be cut off mid-way except by `max_tokens`, which the reservation sets.
- **LiteLLM virtual keys** (per-key budgets inside the Gateway) are the other way. They need the Gateway to have its own Postgres, and the Interceptor already knows who the user is, so it isn't needed.
- Your own shared key (for you, and for anyone you allow to use it) should be a dedicated OpenRouter key with a monthly cap on OpenRouter's side, as a last-resort stop.

## How the Runs page and sandbox runner fit

Runs are the one part that doesn't move to Fly in v1.

- **v1:** the hosted app has the Runs nav hidden (`HARNESS_HOSTED=1` without `RUNNER_URL`). Everything else works.
- **When added:** the runner is a second Fly Machine (its own app, or a process group) reached over Fly's private network with `RUNNER_TOKEN`, which exists for exactly this. It needs a small scratch volume for worktrees, not for state.
- **State moves to Postgres:** `runs` and `run_events` replace the `runs/` folder, so a redeploy or a Machine restart doesn't lose history. The run's work lives in a git branch pushed to GitHub, which is already the design.
- **Repos come from GitHub, not `./repos`:** the user's GitHub OAuth token (scope limited to what Runs needs, stored encrypted) clones and pushes `harness/<id>` branches and opens PRs. This ties OAuth to Runs. Ask for the repo scope only when the user opens Runs, not at sign-in.
- **Commands** run in E2B sandboxes as today (`E2B_API_KEY` is the app's key). Per-user limits cover this too: concurrent runs, minutes per month, and cost in the run record.
- **Approvals** (the guard's `ask`) are tied to the run's owner; only that user (or an admin) can approve.
- **Fly Machines as sandboxes** (Fly's API can start and destroy Machines per run) is an option in the roadmap's Step 4 and is not part of this plan.

## PR order

Each is a separate PR that works on its own and keeps the local, no-database setup working.

1. **Plan** (this document).
2. **Database layer.** *(Done, #98.)* `utils/db.js`, `migrations/`, `npm run migrate`, `DATABASE_URL` optional. A `PgStore` for users, API keys and sessions behind the existing `Store` interface, with sessions in the database. Tests against a throwaway Postgres (Docker, or Neon branch in CI; the repo has no CI today, so local first). Hosted mode off by default.
3. **Fly deploy.** (With `auto_start_machines`/`auto_stop_machines` set, so it sleeps when idle from day one.) `Dockerfile.fly`, `fly.toml`, secrets list, volume, `trust proxy`, health check, `docs/fly.md` with step by step commands for Windows. Usable immediately with the current named logins. This is the first point where Skyler can reach it from a phone without Tailscale or a tunnel.
3a. **Stop button and idle stop.** Admin-only Stop on the Dashboard (Fly Machines API with a scoped token), `HARNESS_IDLE_STOP_MIN`, an idle check that sees streams, Runs and pending approvals. Optional later: the always-on Start page.
4. **Chats in the database (text only).** *(Done in #98 as whole-chat rows, not message rows.)*
4b. **Chat rows, stages 1 and 2.** Message table, user ids, server-side message saving. See [Moving chats to message rows](#moving-chats-to-message-rows).
4c. **Chat rows, stages 3 and 4.** Delta sync, then stop writing the blob. Schema, API, server-side message saving, `ChatStore` in `ui/chat.js`, import from browser, export all. Biggest PR; may split into "API and saving" then "page and import". Attachments are not part of it.
5. **OAuth sign-in.** *(Done in #98 through Neon Auth; Google by default, GitHub with its own OAuth app.)* GitHub and Google, `identities`, invite-only users page, `HARNESS_ADMIN_EMAILS`, account page (link or unlink providers, make API keys), sign-in page buttons.
6. **Per-user settings, routings and MCP.** *(Done: see [Each person's own tools](neon.md#each-persons-own-tools-routings-and-settings).)* Global versus user split, encrypted MCP secrets, stdio MCP and shells admin-only.
7. **Usage, limits and guest accounts.** *(Guests, the hard cap and pasted keys are done: see [Guests](neon.md#guests-and-bringing-your-own-openrouter-key); usage_events and soft caps are not.)* `usage_events`, per-user spend, optional caps and a Users page column, 429 handling in chat, and the guest account (below): only an admin can make one, it uses your shared key with a hard $1 lifetime cap.
8. **OpenRouter workload identity federation per user (the main credential path).** *(Built, stub-tested only: see [the issuer](neon.md#the-harness-as-an-oidc-issuer-federation-per-person).)* The harness as an OIDC issuer (discovery and JWKS), per-user JWTs, a policy id in Account settings, per-request credential in `/openrouter-proxy`. Needs an OpenRouter Business org, so it starts with a one-issuer, one-policy trial in your org.
8b. **Pasted OpenRouter key (optional).** Encrypted static key per user, for anyone without an org. Small; build only if someone needs it.
9. **Attachments (separate goal).** Object storage, `attachments` table, signed uploads, size limits, moving attachment bytes out of the browser, import of existing attachments.
10. **Server-side schedules and keep-alive** (after 4b) (so they run with the tab closed).
11. **Runs on Fly.** Runner Machine, Postgres run records, GitHub-token clone and push, per-user quotas.

Steps 3 and 4 can swap if you would rather have chats in the database before the first deploy; 3 first gives the earliest real use.

## Risks

- **Streaming and timeouts through Fly's proxy** are unverified. Check in PR 3 with a long reply and a Claude Code session before building on it.
- **Neon cold start** on the first request after idle. Mitigate with a retry; test how long it takes.
- **Public exposure.** An open https address invites scanning. Invite-only sign-up, rate limits (exist), and `HARNESS_REQUIRE_LOGIN` on by default in hosted mode. A leaked `hk_` key spends money, hence the limits and the OpenRouter-side cap.
- **Single Machine.** No failover. A deploy restarts everything for several seconds, interrupting streams. Acceptable for personal use.
- **Not tested on real Fly, Neon, LiteLLM or OAuth providers.** This plan is based on the repo and the vendors' pricing pages; I haven't deployed anything.

## Decisions so far

- **Subdomain: `agents.skylerfly.com`** (Skyler, 2026-10-27).
- **Two kinds of user:** guests use Skyler's key (hard $1 cap); full users bring their own OpenRouter credential. No per-person policies or workspace keys in Skyler's org. A full user without a credential is refused until they add one (Skyler, 2026-10-27).
- **Sleeps after 30 idle minutes** (`HARNESS_IDLE_STOP_MIN=30` in hosted mode).
- **Federation** is the main OpenRouter credential path. No-credential users get a **guest account** only Skyler can make, with a $1 lifetime cap on the shared key (Skyler, 2026-10-27).
- **Region and domain:** a Fly region near Colorado, and a subdomain of `skylerfly.com` (DNS is on Netlify). See [Region and domain](#region-and-domain).
- Users are **invited**, not open sign-up (Skyler, 2026-10-27).
- **Bring your own OpenRouter credential**, with OpenRouter workload identity federation as the keyless option (Skyler, 2026-10-27).
- **Start and stop to save cost:** the server sleeps when idle; Fly wakes it on a request, and the UI gets a Stop button (Skyler, 2026-10-27).
- **Attachments are a separate goal** from text chats (PR 9 above).

## Open questions for Skyler

1. **OAuth providers:** GitHub and Google first. Any others (Apple, Microsoft, email-and-password only)?
2. **Auth:** happy with self-hosted OAuth now and AuthKit only if needs grow?
3. **MCP and shell for other users:** remote MCP servers only for non-admins, with stdio and shell for you alone. OK?
4. **Runs:** hidden until PR 11, or earlier than attachments and WIF?
5. **Start button:** is waking by opening the address, plus Stop and idle stop, enough, or do you also want a separate always-on Start page?
6. **Neon plan:** Free to start (sleeps after 5 idle minutes), or Launch from day one?
7. **Existing chats:** import from the browser you use now, and keep localStorage working offline when no database is set (the plan says yes)?
