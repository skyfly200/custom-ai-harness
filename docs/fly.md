# Run it on Fly.io

Run the harness on [Fly.io](https://fly.io) at your own address, with chats and sign-in in [Neon](neon.md). Back to the [README](../README.md). The reasoning and costs are in the [hosted app plan](hosted-app-plan.md). For your own server or a VPS instead, see [Run it on a server](server-docker.md).

**What you get.** One small Fly Machine (1 GB, about $6.70 a month while it runs) running the Gateway, Router and Interceptor from one image (`Dockerfile.fly`, started by `docker/fly-start.js`). Fly adds https. Only the Interceptor is reachable from outside. A 1 GB volume (about $0.15 a month) keeps the files the Routing page edits. The local engine and Ollama are not part of this, so strong requests use OpenRouter models.

**Not tested on real Fly yet.** The image builds and starts all three parts (checked locally in Docker, about 365 MB of memory), but the steps below have not been run against a Fly account. Tell me where one fails.

## Steps (PowerShell)

1. **Install the Fly tool and sign in:**
   ```powershell
   iwr https://fly.io/install.ps1 -useb | iex
   fly auth login
   ```
2. **Pick the app name.** Names are shared by all of Fly, so open `fly.toml` and change `app = "skyler-agents"` to one nobody has taken. Fly has no Denver region, so the files use Dallas (`dfw`), the closest to Colorado.
3. **Create the app and its volume** (use your region code; the volume must be in the Machine's region):
   ```powershell
   fly apps create YOUR-APP-NAME
   fly volumes create agents_data --app YOUR-APP-NAME --region dfw --size 1
   ```
4. **Set the secrets.** These stay in Fly, not in the repo or the image:
   ```powershell
   npm run hash        # makes the hash for the break-glass admin password; paste it below
   fly secrets set --app YOUR-APP-NAME `
     DATABASE_URL="postgresql://...-pooler..." `
     NEON_AUTH_BASE_URL="https://...neonauth.../neondb/auth" `
     HARNESS_ADMINS="skyler:scrypt.16384...." `
     HARNESS_ADMIN_EMAILS="you@example.com" `
     LITELLM_MASTER_KEY="sk-any-long-random-text" `
     OPENROUTER_API_KEY="sk-or-..."
   ```
   `DATABASE_URL` is the **pooled** Neon string (the host has `-pooler`); see [Chats and sign-in in Neon](neon.md). `HARNESS_ADMINS` is required whenever logins are on: it is a password login that works even if Google sign-in is down. `HARNESS_ADMIN_EMAILS` makes your Google account an admin.
5. **Deploy one Machine** (the volume can only be used by one):
   ```powershell
   fly deploy --app YOUR-APP-NAME --ha=false
   fly status --app YOUR-APP-NAME
   ```
   The first start takes a minute or two while LiteLLM loads. `fly logs --app YOUR-APP-NAME` shows it.
6. **Point `agents.skylerfly.com` at it.**
   ```powershell
   fly certs add agents.skylerfly.com --app YOUR-APP-NAME
   ```
   It prints the DNS records it wants. In Netlify DNS for `skylerfly.com`, add a `CNAME` record named `agents` with the value `YOUR-APP-NAME.fly.dev`, plus the `_acme-challenge` record if Fly asks for one. Then run `fly certs check agents.skylerfly.com --app YOUR-APP-NAME` until the certificate shows as issued. (Netlify only provides the DNS here; nothing is hosted there.)
7. **Tell Neon Auth about the address**, or Google sign-in is refused:
   ```powershell
   neon neon-auth domain add https://agents.skylerfly.com
   ```
8. **Sign in** at `https://agents.skylerfly.com` with Google (an invited email or one in `HARNESS_ADMIN_EMAILS`) or with the admin name and password from step 4.

## Deploy automatically

A GitHub Actions workflow (`.github/workflows/fly-deploy.yml`) runs `fly deploy --ha=false` every time something merges to `master`. Changes that only touch `docs/`, `test/` or `.md` files don't deploy. You can also run it by hand from the repo's **Actions** tab (Deploy to Fly, Run workflow). Set it up once:

1. **Make a token that can only deploy this app** (PowerShell):
   ```powershell
   fly tokens create deploy --app YOUR-APP-NAME --name github-actions
   ```
   It prints a long line starting with `FlyV1`. Copy the whole line.
2. **Save it as a GitHub secret.** In the repository go to Settings, Secrets and variables, Actions, New repository secret. Name it `FLY_API_TOKEN` and paste the line. (Or, with the GitHub CLI: `fly tokens create deploy --app YOUR-APP-NAME | gh secret set FLY_API_TOKEN`.)
3. **Merge something to `master`** (or run the workflow by hand) and watch the Actions tab. The deploy takes a few minutes.

Notes: the token can deploy and nothing else; revoke it with `fly tokens list` and `fly tokens revoke`. The app name comes from `fly.toml`. Secrets stay in Fly (`fly secrets set`), so deploys don't need them in GitHub. Nothing runs the tests first, since the repo has no CI; run `npm test` before merging. This workflow has not run against a real Fly account yet.

## Using it from Claude Code and other tools

Make an API key on the **Users** page, then:

```powershell
$env:ANTHROPIC_BASE_URL = "https://agents.skylerfly.com"
$env:ANTHROPIC_AUTH_TOKEN = "hk_..."
$env:CLAUDE_CODE_AUTO_MODE_SERVER = "0"
claude
```

Other tools use `https://agents.skylerfly.com/v1` with the key as their API key.

## Keeping the cost down

The Machine bills only while it runs, so the app stops itself:

- **It sleeps after 30 idle minutes** (`HARNESS_IDLE_STOP_MIN` in `fly.toml`; `0` turns it off). Opening a page, a request to `/v1` (Claude Code, other tools) or any save counts as use. The Dashboard polling for status or holding the live feed open does not, or an open tab would keep it awake. A reply still being answered or saved keeps it awake whatever the clock says.
- **The first message after a sleep waits for the Gateway.** LiteLLM takes a minute or more to load after the Machine wakes, so the Interceptor holds a request until the Gateway's port opens (up to `HARNESS_GATEWAY_WAIT_S`, 240 seconds on Fly) instead of answering 502. The chat shows it as a slow first reply.
- **The Dashboard has a Stop server button** (admins only) for stopping it right now. It asks first.
- **Opening the address wakes it.** Fly starts a stopped Machine when a request arrives. The first request waits while the Machine boots and LiteLLM starts (a minute, not measured); Claude Code may need to retry its first call.

How it works: the app asks the launcher to stop, which stops all three parts and exits with code 0. `fly.toml` sets the Machine's restart policy to `on-failure`, so a clean exit leaves it stopped and only a crash restarts it. If your Machine restarts itself after a stop, check `fly machine status MACHINE-ID` for its restart policy. To stop it from your own computer instead: `fly machine stop MACHINE-ID --app YOUR-APP-NAME`.

While it sleeps, anything that must happen with no one there (cache keep-alive pings) does not run; scheduled messages keep the server awake instead, see below. Chats are safe: they are in Neon. If you were halfway through a reply when it stopped, the server keeps what it had (see below). The volume is billed even while the Machine is stopped, and Neon sleeps on its own after 5 idle minutes.

## Replies survive a closed tab

With a database set, the chat page tells the server which chat and message a reply belongs to. If the page goes away (tab closed, phone locked, connection lost) before the reply ends, the server saves the words that arrived, with a note that it was cut off, and the next device you open shows it. If the page is still there it saves its own, fuller copy a moment earlier and the server's copy is skipped. This keeps text only; a reply that was in the middle of running tools stops at the tools, because the page runs them.

## Looking after it

| To | Run |
|---|---|
| See what it's doing | `fly logs --app YOUR-APP-NAME` |
| Update to the latest version | merge to `master` (deploys by itself once [set up](#deploy-automatically)), or `git pull` then `fly deploy --app YOUR-APP-NAME --ha=false` |
| Change a secret | `fly secrets set NAME=value --app YOUR-APP-NAME` (restarts the Machine) |
| Apply a model change from the Routing page | the Gateway reads `config.yaml` at start: `fly machine restart MACHINE-ID --app YOUR-APP-NAME` |
| Open a shell on it | `fly ssh console --app YOUR-APP-NAME` |

**Config files live on the volume.** `config.yaml` and `routellm-config.yaml` are copied onto the volume the first time and edited there by the Routing and Settings pages, so a deploy doesn't undo your changes. When a new version ships a different copy, the volume's file is left alone and the new one is saved next to it as `config.yaml.new`; compare them in `fly ssh console` (under `/app/data`) and copy over anything you want.

**What stays on the volume and what goes to Neon.** Users, sessions and chats are in Neon. The volume holds `config.yaml`, `routellm-config.yaml`, the Settings and routing files, usage totals and `mcp-servers.json`.

**Limits to know about.** One Machine means no failover: a deploy or restart interrupts any reply in progress. Chat repo linking, the PC shell and stdio MCP servers run inside the Machine, so keep them to people you trust (a limit for other users comes with the per-user settings PR).

## Scheduled messages on the server

With `DATABASE_URL` set, scheduled messages are sent by the server (`utils/serverSchedules.js`), not by an open page. Every 30 seconds it looks at each person's schedules, claims one that is due by moving its next time forward in the same database row (so a stale page or a second server can't send it twice), adds the message to the target chat, asks the model through its own `/v1/chat/completions` as that person (so routing, guest credit and the person's own OpenRouter credential all apply) and saves the reply. The page notices the new chat within a minute.

- **It stays awake.** Fly can't wake a stopped Machine for a schedule, so while any schedule has a next run the idle sleep (`HARNESS_IDLE_STOP_MIN`) holds off. Set `HARNESS_SCHEDULES_KEEP_AWAKE=0` to let it sleep anyway (schedules then run late, when something wakes it). That makes the Machine cost the full month (about $6 to $7 on shared-cpu-1x 1 GB).
- **What a run has:** the chat's history (text attachments included, images are noted but not sent), the project's instructions, the chat's system prompt and notes, switched-on skills, and the chat's or project's routing. It has **no tools** (MCP, repo, shell).
- **Time zones.** The page saves its time zone with each schedule; daily, weekday and weekly runs keep the same wall-clock time through daylight saving.
- **Off:** `HARNESS_SERVER_SCHEDULES=0` returns to the page sending them. With no database nothing changes.
- A run that fails (out of credit, model error) writes the error into the reply. A schedule missed while the server was down runs once when it is back.
- Cache keep-alive pings still run in the page; they only matter while someone is there.

## Connect GitHub

**Connect GitHub** (Agents page, and Options → Tools in a chat) lets each person link their own GitHub account once. The connection serves two things: chats attach a repo and read it through GitHub's API, and Runs clone and push their branches. One token per person, stored encrypted in `user_github` (`ENCRYPTION_KEY` needed); a pasted token on the Agents page still works and replaces it. It is separate from "Continue with GitHub" sign-in, which is Neon Auth's own OAuth app.

Set it up once (you, as owner):

1. **Make a GitHub App** (recommended: each person grants only the repos they choose, and the token expires after 8 hours and renews itself) at GitHub > Settings > Developer settings > GitHub Apps > New.
   - **Redirect URI:** `https://agents.skylerfly.com/ui/api/me/github/callback` (your `HARNESS_PUBLIC_URL` + `/ui/api/me/github/callback`; add `http://localhost:3000/ui/api/me/github/callback` too if you test locally). GitHub's App settings page labels this field **Callback URL**; it is the same address as the `redirect_uri` in GitHub's OAuth docs, and the two must match exactly (a trailing slash or http versus https is enough to make GitHub refuse the sign-in).
   - Leave **Expire user authorization tokens** on. Turn **Webhook** off.
   - **Repository permissions:** Contents: Read and write (Runs push; chats only read), Issues: Read and write, Pull requests: Read and write, **Actions: Read and write** (chats read runs and logs, and start, re-run or cancel workflows), Metadata: Read. Add **Workflows: Read and write** only if agents should be able to push changes to `.github/workflows` files (Runs); chats never edit files. Drop the write levels if you only want chats to read.
   - Install it on your account, and let others install it ("Any account") if you invite people who are not you.
   - Copy the **Client ID**, make a **Client secret**, and note the app's URL slug (`github.com/apps/<slug>`).
2. **Set the secrets** (the Machine restarts):
   ```powershell
   fly secrets set --app YOUR-APP-NAME `
     GITHUB_CLIENT_ID="Iv1...." `
     GITHUB_CLIENT_SECRET="..." `
     GITHUB_APP_SLUG="your-app-slug"
   ```
   Without `GITHUB_APP_SLUG` the harness treats the app as a plain **OAuth App** instead (GitHub > Developer settings > OAuth Apps, same redirect URI; an OAuth App's field is also labelled "Authorization callback URL"): it asks for the `repo` scope, which reaches every repo the person can, public and private, and the token does not expire. Set `GITHUB_OAUTH_SCOPE=public_repo` for public repos only.
3. Each person presses **Connect GitHub**. With a GitHub App they then use **Choose which repos it can reach** (a link next to the repo box) to install it on the repos they want; the repo list shows only those.

Notes: `HARNESS_PUBLIC_URL` must be set to the address people use, so the redirect URI the harness sends is one GitHub accepts. Guests cannot connect GitHub. A person's token is only ever sent to GitHub, and to the task runner for one request at a time; the model never sees it. Opening an issue, comment or pull request from a chat always waits for that person's Allow.

## Runs on Fly

The Agents page (Runs, agents, swarms) works on a hosted server when you set `HARNESS_RUNS=1`. The launcher then starts the task runner as a fourth process in the same Machine, on loopback only, in **hosted mode** (`RUNNER_HOSTED=1`):

- **Turn it on (PowerShell).** Without `HARNESS_RUNS`, the Agents page says Agents are not turned on. From the repo folder:

  ```powershell
  fly secrets set --app skyler-agents HARNESS_RUNS=1 HARNESS_RUNS_FOR=users E2B_API_KEY=your-key
  ```

  Leave out `HARNESS_RUNS_FOR=users` to keep Agents to admins. For Sprites use `SPRITES_TOKEN=...` instead of `E2B_API_KEY`. Setting secrets restarts the Machine; if the runner can't start, the whole Machine stops and `fly logs --app skyler-agents --no-tail` shows why. The sandbox provider bills your E2B or Fly account for the minutes agents use, so also set the per-person limits below.
- **Cloud sandboxes only.** Agents run commands in [E2B](https://e2b.dev) or a Fly Sprite, never on the Machine itself. Set `E2B_API_KEY` or `SPRITES_TOKEN` as a Fly secret (the runner picks Sprites when its token is set, else E2B). The local worktree sandbox, previews, Apps, ticket files and the folder browser are off.
- **Whose runs.** Each run and agent belongs to the person who made it; nobody else can list, read, stop, approve or delete it. By default only admins may use Runs; `HARNESS_RUNS_FOR=users` lets every signed-in, non-guest person (guests never can).
- **Whose money.** The runner calls the harness as the run's owner (`utils/runnerAuth.js`, a token shared only between the two processes for that boot), and a run's key carries its owner, so the model calls are billed like that person's chat: an admin's on the server's key, other people's on their own OpenRouter credential when `HARNESS_USER_CREDENTIALS=1`.
- **Repos come from GitHub.** A repo is named `owner/name`. On **Agents > GitHub** a person presses **Connect with GitHub** ([above](#connect-github)) or pastes a fine-grained token (Contents: read and write on the repos they use); it is checked once, stored encrypted (`ENCRYPTION_KEY`, table `user_github`) and handed to the runner for one request at a time as a git header. It is never in a remote URL, on disk or in a sandbox. The runner keeps a clone per person under `HARNESS_DATA_DIR/repos`; the run's work comes back to that clone as `harness/<id>`. **Push branch to GitHub** on a finished run pushes only that branch, using the person's token; nothing is pushed on its own.
- **Limits per person** (env on the runner): `RUNNER_USER_MAX_RUNS` runs at once (2), `RUNNER_USER_MAX_MINUTES` per run (30), `RUNNER_USER_MAX_COST` dollars a run when none is set (2; a higher one is lowered to it), `RUNNER_USER_MONTHLY_MINUTES` of run time a month (0 = no limit). Sandbox minutes are billed to the E2B or Fly account, so set these before inviting people.
- **Where it is kept.** Run records, agents and clones are on the volume (`HARNESS_DATA_DIR/runs` and `/repos`), not in Postgres: with one Machine the volume survives restarts and deploys. The plan's Postgres run records are not built; a second Machine would need them.
- **Sleep.** A run's model calls count as use, so the server doesn't sleep in the middle of one. If the Machine does stop, the run is marked failed when it starts again and its sandbox is destroyed.
