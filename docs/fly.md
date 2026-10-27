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
2. **Pick the app name.** Names are shared by all of Fly, so open `fly.toml` and change `app = "skyler-agents"` to one nobody has taken. If `fly platform regions` doesn't list Denver (`den`), change `primary_region` to `dfw`.
3. **Create the app and its volume** (use your region code; the volume must be in the Machine's region):
   ```powershell
   fly apps create YOUR-APP-NAME
   fly volumes create agents_data --app YOUR-APP-NAME --region den --size 1
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
- **The Dashboard has a Stop server button** (admins only) for stopping it right now. It asks first.
- **Opening the address wakes it.** Fly starts a stopped Machine when a request arrives. The first request waits while the Machine boots and LiteLLM starts (a minute, not measured); Claude Code may need to retry its first call.

How it works: the app asks the launcher to stop, which stops all three parts and exits with code 0. `fly.toml` sets the Machine's restart policy to `on-failure`, so a clean exit leaves it stopped and only a crash restarts it. If your Machine restarts itself after a stop, check `fly machine status MACHINE-ID` for its restart policy. To stop it from your own computer instead: `fly machine stop MACHINE-ID --app YOUR-APP-NAME`.

While it sleeps, anything that must happen with no one there (schedules, cache keep-alive pings) does not run. Chats are safe: they are in Neon. If you were halfway through a reply when it stopped, the server keeps what it had (see below). The volume is billed even while the Machine is stopped, and Neon sleeps on its own after 5 idle minutes.

## Replies survive a closed tab

With a database set, the chat page tells the server which chat and message a reply belongs to. If the page goes away (tab closed, phone locked, connection lost) before the reply ends, the server saves the words that arrived, with a note that it was cut off, and the next device you open shows it. If the page is still there it saves its own, fuller copy a moment earlier and the server's copy is skipped. This keeps text only; a reply that was in the middle of running tools stops at the tools, because the page runs them.

## Looking after it

| To | Run |
|---|---|
| See what it's doing | `fly logs --app YOUR-APP-NAME` |
| Update to the latest version | `git pull`, then `fly deploy --app YOUR-APP-NAME --ha=false` |
| Change a secret | `fly secrets set NAME=value --app YOUR-APP-NAME` (restarts the Machine) |
| Apply a model change from the Routing page | the Gateway reads `config.yaml` at start: `fly machine restart MACHINE-ID --app YOUR-APP-NAME` |
| Open a shell on it | `fly ssh console --app YOUR-APP-NAME` |

**Config files live on the volume.** `config.yaml` and `routellm-config.yaml` are copied onto the volume the first time and edited there by the Routing and Settings pages, so a deploy doesn't undo your changes. When a new version ships a different copy, the volume's file is left alone and the new one is saved next to it as `config.yaml.new`; compare them in `fly ssh console` (under `/app/data`) and copy over anything you want.

**What stays on the volume and what goes to Neon.** Users, sessions and chats are in Neon. The volume holds `config.yaml`, `routellm-config.yaml`, the Settings and routing files, usage totals and `mcp-servers.json`.

**Limits to know about.** One Machine means no failover: a deploy or restart interrupts any reply in progress. Chat repo linking, the PC shell and stdio MCP servers run inside the Machine, so keep them to people you trust (a limit for other users comes with the per-user settings PR).
