# Custom AI Coding Harness

## What this is, in plain words

The harness is a middleman between your AI coding assistant (Claude Code, Cursor and similar tools) and the AI models that answer it. Your assistant talks to the harness as if it were the AI service. For every request, the harness decides how hard the task is, sends easy work to free models and hard work to a stronger model, and trims the request so it uses fewer tokens. If one model is down or rate-limited, it automatically tries the next one.

What you get:

- **Lower cost.** Most requests go to free models, and requests are compressed before they are sent.
- **Fewer failures.** When a model refuses, errors or hits its limit, another one takes over.
- **Bright Chat.** A web app with a chat page, projects and costs, plus a dashboard with your recent chats, a usage summary and what each request did, and a Settings page for changing settings without editing files.

### The three parts you run

| Part | What it does | Address |
|------|--------------|---------|
| **Interceptor** | The front door. Your coding assistant connects here. It also serves Bright Chat, the web app with the dashboard and chat page. | http://localhost:3000 |
| **Router** | Looks at each request and answers one question: does this need a strong model, or will a free one do? | http://localhost:6060 |
| **Gateway** (LiteLLM) | Sends the request to the chosen model and switches to a backup if that one fails. | http://localhost:4000 |

A fourth part, a **local engine** (a model running on your own computer), is optional. Without it, everything goes to the free cloud models.

## Quick start (Windows)

The steps below use PowerShell. Mac and Linux commands are in [Installation](docs/installation.md#installation) and [Running the stack by hand](docs/running-the-stack.md#running-the-stack-by-hand).

### What you need first

- **Node.js** 18 or newer: <https://nodejs.org>
- **Python** 3.10 or newer: <https://www.python.org/downloads/>
- **Git**: <https://git-scm.com>
- **API keys** from [Groq](https://console.groq.com/keys) and [OpenRouter](https://openrouter.ai/keys). Both have free tiers, and the models the harness sends work to are free. The one exception is the Router's request classifier (Jev, through OpenRouter), which costs a small amount per request, so keep a little credit on your OpenRouter account. [Router classifier](docs/configuration.md#router-classifier-jev-through-openrouter) explains how to swap it for a free one.

### One-time setup

1. Download the harness and install what it needs:

   ```powershell
   git clone https://github.com/skyfly200/custom-ai-harness.git
   cd custom-ai-harness
   npm install
   python -m venv .venv
   .\.venv\Scripts\Activate.ps1
   pip install "litellm[proxy]" routellm
   ```

   If PowerShell refuses to run `Activate.ps1`, run `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser` once and try again.

2. Create your settings file and paste in your keys:

   ```powershell
   Copy-Item .env.example .env
   notepad .env
   ```

   Fill in `GROQ_API_KEY=` and `OPENROUTER_API_KEY=`, then save. The file stays on your computer; Git ignores it, so it is never pushed to GitHub.

### Every time you want to use it

Open a PowerShell window, `cd` into the `custom-ai-harness` folder and run:

```powershell
npm run all
```

This starts all three parts in that one window, each line marked with the part it came from (`[gateway]`, `[router]`, `[interceptor]`). It uses the `.venv` from the setup by itself, so you don't need `Activate.ps1` first. Leave the window open while you work; Ctrl+C stops everything.

Then open Bright Chat, the harness's web app, at <http://localhost:3000/ui>. It opens on the dashboard. When the Router and Gateway show as up, the harness is ready; the Gateway takes a little while to start, so give it a moment. The local engine, Ollama and Laya are optional and normally show as "not running".

**Ollama is off by default.** Run `npm run all:ollama` instead when you want it too, or put `START_OLLAMA=1` in `.env` to always start it. If the Ollama app is already running in the background, it is left alone.

If you'd rather have one window per part (easier to read when something goes wrong), run these in three windows instead:

| Window | Starts | Command |
|--------|--------|---------|
| 1 | Gateway | `.\.venv\Scripts\Activate.ps1; $env:PYTHONUTF8 = 1; litellm --config config.yaml` |
| 2 | Router | `.\.venv\Scripts\Activate.ps1; python router.py` |
| 3 | Interceptor | `npm start` |

### Connect Claude Code

Leave the harness running, open a fourth PowerShell window in the same folder and run:

```powershell
npm run claude
```

That sets the variables below for you and starts Claude Code in this folder. Add `--` to pass Claude Code its own options (`npm run claude -- -p "explain router.py"`). Set `HARNESS_URL` in `.env` to use a harness on another machine, and `HARNESS_API_KEY` to an API key from the Users page when the harness runs with `HARNESS_REQUIRE_LOGIN=1`. Set `CLAUDE_CODE_BIN` if `claude` is not the command on your PATH.

The script only sets those variables; it does not install Claude Code. Install Claude Code and make sure its command is on your PATH first. On Windows, the launcher resolves either `claude.exe` or `claude.cmd`; if it is installed somewhere else, set `CLAUDE_CODE_BIN` to its full path. If the harness isn't answering it says so instead of starting Claude Code, so start `npm run all` first.

```powershell
$env:ANTHROPIC_BASE_URL = "http://localhost:3000"
$env:ANTHROPIC_AUTH_TOKEN = "local-harness"
$env:CLAUDE_CODE_AUTO_MODE_SERVER = "0"
claude
```

These settings only last for that window. Other tools such as Cursor, Aider, Continue or Cline connect to `http://localhost:3000/v1` as an "OpenAI-compatible" endpoint.

### Next steps

- Use Bright Chat from your phone, or install it as an app: [Phone and installable app](docs/phone-and-app.md).
- Run the harness on a server so it is always on: [Run it on a server](docs/server-docker.md).
- Run it on Fly.io at your own address, with chats in Neon: [Run it on Fly.io](docs/fly.md).
- Plan work with `/wayfinder` and check commands with the guard: [Claude Code and agent tools](docs/claude-code.md).

### If something goes wrong

- **The dashboard shows the Router or Gateway as down.** Look for an error in the lines marked `[router]` or `[gateway]` (or in that window, if you use three). Most often a key in `.env` is missing or mistyped.
- **`litellm` crashes on start with a text-encoding error.** `npm run all` sets this for you; with three windows, make sure you ran `$env:PYTHONUTF8 = 1` in the Gateway window first.
- **`litellm` or `python router.py` says a command or module is not found.** `npm run all` prints a warning when it can't find the `.venv`; redo step 1 of the setup in the `custom-ai-harness` folder. With three windows, run `.\.venv\Scripts\Activate.ps1` in each one first.
- **Requests are slow or fail with "rate limit".** The free tiers have limits per minute and per day. The harness switches to backups on its own; the dashboard shows which ones it tried. A red **rate limit** tag in the routing log means every backup was out of quota too, and the text under it is the provider's own message. OpenRouter's free models share one daily allowance across all of them, which Claude Code can use up quickly; it resets daily, and keeping $10 of OpenRouter credit raises it from 50 to 1,000 requests a day (OpenRouter's limits when this was written).
- **Every request says "Router down".** The Router couldn't classify it, so the request went to the backup model. The text under the tag says why (for example an error from Jev or a missing key).
- **`npm run all:ollama` says `ollama` is not recognized.** Install Ollama from ollama.com, or use plain `npm run all`.
- **Every strong request shows fallbacks.** The strong model is the local engine on port 8000 (Tier 1). When it isn't running, each strong request falls through to the OpenRouter models, which is expected but slower.
- **A request seems stuck.** It now fails with a **timeout** instead of hanging: after 5 minutes with no answer from the Gateway, or 2 minutes of silence in the middle of a reply. Both limits are in the Interceptor settings on the Settings page.

## Serverless setup (Netlify or Vercel)

A second way to run the harness, parallel to the Docker and Fly setup above. It runs on Netlify or Vercel as Node functions and sends each request straight to OpenRouter, with no LiteLLM, Router or database. The LiteLLM stack keeps working unchanged. Details: [Serverless harness](docs/serverless.md).

What you get: `POST /v1/chat/completions` (OpenAI format, streamed), `GET /v1/models`, and `GET /healthz`. The same request transforms as the Docker stack run first: caveman, context anchor and Headroom. Headroom's real compression, when you want it, runs as a Fly Sprite that sleeps when idle.

### What you need

1. An **OpenRouter** key (`OPENROUTER_API_KEY`). Set a spending limit on it.
2. A **random access key** for your clients (`SERVERLESS_API_KEY`). Make one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
3. A **Netlify** or **Vercel** account, with this repository connected.
4. Optional, for real Headroom compression: a **Fly.io** account with a Sprites token (`SPRITES_TOKEN`) and Node 24 on your own machine.

### Steps

1. **Deploy the functions.**
   - *Netlify:* New site, import this repository. The settings come from `netlify.toml` (publish folder `serverless/public`, functions in `netlify/functions`). No build command.
   - *Vercel:* Add New Project, import this repository, no build step. `vercel.json` rewrites `/v1/*` to the Edge function in `api/v1/`.
2. **Set the environment variables** in the site or project settings, then redeploy:
   - `OPENROUTER_API_KEY`, `SERVERLESS_API_KEY` (required; without them every `/v1` call answers 503).
   - `HARNESS_STRONG_MODEL` and `HARNESS_WEAK_MODEL` if you want other models than `anthropic/claude-sonnet-5.5` and `anthropic/claude-haiku-5.5`.
   - Leave the Headroom variables for step 4, or skip step 4 entirely.
3. **Check it answers:** open `https://<your-site>/healthz`. It should show `{"ok":true}`. Then call the API:
   ```bash
   curl https://<your-site>/v1/chat/completions \
     -H "Authorization: Bearer $SERVERLESS_API_KEY" -H "Content-Type: application/json" \
     -d '{"messages":[{"role":"user","content":"Say hi"}]}'
   ```
   Point an OpenAI-compatible client at `https://<your-site>/v1` with that key.
4. **Optional: Headroom on a Sprite.** Headroom's compression server is Python, so it runs on Fly Sprites rather than on the functions:
   ```bash
   # on your own machine, Node 24 or newer, in the repo folder
   npm install
   export SPRITES_TOKEN=...            # from your Fly account
   export HEADROOM_PROXY_TOKEN=$(node scripts/headroom-sprite.mjs token)   # save this value
   node scripts/headroom-sprite.mjs setup
   ```
   `setup` creates a sprite named `harness-headroom`, installs `headroom-ai[proxy]` 0.42.0 in it, starts the proxy on port 8787 with your token, and prints three lines. Put them in the site's environment variables: `HEADROOM_URL`, `HEADROOM_API_KEY` and `HEADROOM_TIMEOUT_MS`. Then redeploy.
   - The sprite sleeps when idle and wakes on the next request, which takes a few seconds. A request that arrives during that wait goes on uncompressed; nothing fails.
   - Check it with `node scripts/headroom-sprite.mjs status`. Run `setup` again with the same token to update it.
5. **Switch things off if you need to:** `HARNESS_CAVEMAN=0`, `HARNESS_CONTEXT_ANCHOR=0` or `HARNESS_HEADROOM=0`.

### What is not on the serverless setup yet

The chat web pages, usage logs, sign-in, MCP tools, the task runner and Claude Code's Anthropic format stay on the Docker or Fly stack. Use the serverless setup as a plain OpenAI-compatible endpoint for now.

## More detail

Everything past the quick start lives in `docs/`. Each page starts with a one-line summary of what it covers.

| Page | What is in it |
|------|---------------|
| [Installation](docs/installation.md) | Prerequisites and install steps for macOS, Linux and Windows |
| [Configuration](docs/configuration.md) | `.env` keys, `config.yaml`, `routellm-config.yaml`, and the Router classifier (Jev, Laya, RouteLLM) |
| [Running the stack by hand](docs/running-the-stack.md) | Start the local engine, Gateway, Router and Interceptor one at a time |
| [Claude Code and agent tools](docs/claude-code.md) | Connect Claude Code, `/wayfinder`, the command guard, `ask_jev_file` tools |
| [Chat page](docs/chat.md) | Projects, skills, commands, MCP tools and git repos, voice, read-aloud and notifications, and imports from Claude Code |
| [Dashboard, settings and usage](docs/control-ui.md) | The dashboard, the Settings page, the Usage page |
| [Routing](docs/routing.md) | The routing editor, named strategies, tiers, effort, and how a request gets its model |
| [Task runner](docs/task-runner.md) | Agents that do a whole task: workflows, swarm, E2B cloud sandboxes |
| [ChatDev](docs/chatdev.md) | Run the ChatDev multi-agent tool in a Fly Sprite with its models routed through the harness |
| [Run it on a server](docs/server-docker.md) | Docker, Oracle and Google Cloud free tiers, Tailscale, `HARNESS_MODE` and local models |
| [Serverless harness](docs/serverless.md) | Netlify or Vercel functions with no LiteLLM: settings, transforms, the Headroom Sprite, limits |
| [Run it on Fly.io](docs/fly.md) | One Machine, Neon, your own domain, start and stop to save cost |
| [Phone and installable app](docs/phone-and-app.md) | Install Bright Chat as an app, and a Cloudflare tunnel for your phone |
| [Named logins and API keys](docs/logins.md) | `HARNESS_REQUIRE_LOGIN`, admins and per-program keys |
| [Langfuse](docs/langfuse.md) | See every model call grouped by chat or run |
| [Architecture](ARCHITECTURE.md) | The one-page map: processes, request flow, hosted setup, auth and storage, where each concern lives |
| [Architecture and files](docs/architecture.md) | How the parts fit together, and what each file does |
| [Utility scripts and tests](docs/development.md) | `npm run all`, config validation, context compression, the test suite |
| [Hand testing checklist](docs/hand-testing.md) | Manual checks on a real phone |
| [Roadmap](ROADMAP.md) | What is built and what is planned |

## License

MIT
