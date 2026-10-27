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

---

## Quick start (Windows)

The steps below use PowerShell. Mac and Linux commands are in [Installation](#installation) and [Running the stack](#running-the-stack).

### What you need first

- **Node.js** 18 or newer: <https://nodejs.org>
- **Python** 3.10 or newer: <https://www.python.org/downloads/>
- **Git**: <https://git-scm.com>
- **API keys** from [Groq](https://console.groq.com/keys) and [OpenRouter](https://openrouter.ai/keys). Both have free tiers, and the models the harness sends work to are free. The one exception is the Router's request classifier (Jev, through OpenRouter), which costs a small amount per request, so keep a little credit on your OpenRouter account. [Router classifier](#router-classifier-jev-through-openrouter) explains how to swap it for a free one.

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

### Draft an orchestration plan

In Claude Code, run `/wayfinder <goal>` to map a goal into project destinations, unresolved domain questions, and a dependency-ordered JSON ticket draft. Wayfinder is planning-only: it does not edit the repository or create GitHub issues, and every drafted ticket remains not Ready until a person reviews and enters it in the tracker.

### Install Bright Chat as an app

Bright Chat can be installed so it opens in its own window, with its own icon, like any other app. It needs the page to be opened at `http://localhost:3000/ui/chat.html` or over `https://` (a server behind a tunnel or Tailscale `serve`; see [Reach it from your phone](#reach-it-from-your-phone)); a plain `http://` address on your network can't be installed.

| Where | How |
|---|---|
| Chrome or Edge on a computer | Click the **Install app** button in the top bar, or the install icon at the right end of the address bar |
| Chrome on Android | Menu (⋮) → **Install app** (or **Add to Home screen**) |
| Safari on iPhone or iPad | Share → **Add to Home Screen** |

The installed app opens the chat page, and the Dashboard, Usage, Routing and Settings pages are shortcuts on its icon. It still needs the harness running: the app keeps a copy of the pages so it opens when the harness is slow or off, but chats and answers come from the harness and are never stored by the app. If you set `HARNESS_PASSWORD`, the app asks for it the same way the browser does.

### If something goes wrong

- **The dashboard shows the Router or Gateway as down.** Look for an error in the lines marked `[router]` or `[gateway]` (or in that window, if you use three). Most often a key in `.env` is missing or mistyped.
- **`litellm` crashes on start with a text-encoding error.** `npm run all` sets this for you; with three windows, make sure you ran `$env:PYTHONUTF8 = 1` in the Gateway window first.
- **`litellm` or `python router.py` says a command or module is not found.** `npm run all` prints a warning when it can't find the `.venv`; redo step 1 of the setup in the `custom-ai-harness` folder. With three windows, run `.\.venv\Scripts\Activate.ps1` in each one first.
- **Requests are slow or fail with "rate limit".** The free tiers have limits per minute and per day. The harness switches to backups on its own; the dashboard shows which ones it tried. A red **rate limit** tag in the routing log means every backup was out of quota too, and the text under it is the provider's own message. OpenRouter's free models share one daily allowance across all of them, which Claude Code can use up quickly; it resets daily, and keeping $10 of OpenRouter credit raises it from 50 to 1,000 requests a day (OpenRouter's limits when this was written).
- **Every request says "Router down".** The Router couldn't classify it, so the request went to the backup model. The text under the tag says why (for example an error from Jev or a missing key).
- **`npm run all:ollama` says `ollama` is not recognized.** Install Ollama from ollama.com, or use plain `npm run all`.
- **Every strong request shows fallbacks.** The strong model is the local engine on port 8000 (Tier 1). When it isn't running, each strong request falls through to the OpenRouter models, which is expected but slower.
- **A request seems stuck.** It now fails with a **timeout** instead of hanging: after 5 minutes with no answer from the Gateway, or 2 minutes of silence in the middle of a reply. Both limits are in the Interceptor settings on the Settings page.

## Run it on a server (Docker)

You can run the harness on a rented or free cloud server (a VPS) instead of your PC, so it is always on and you can reach it from any of your devices. The server runs all three parts in Docker containers. Out of the box the local engine and Ollama don't run there, so strong requests use the OpenRouter backups (the same as when your engine is off today); [Choose how it works](#choose-how-it-works) shows how to add local models or pick other models.

**Which server.** The three parts use about 450 MB of memory together with the default Router setting (Jev through OpenRouter). Oracle Cloud's Always Free "Ampere A1" server (up to 4 CPUs and 24 GB) is the roomiest free choice. The 1 GB free servers (Google Cloud e2-micro, AWS, Azure) also fit, but building the images is slow on them and needs swap; see [Google Cloud's free tier instead](#on-google-clouds-free-tier-instead). The RouteLLM BERT Router setting needs about 2 GB more, so use it only on the bigger server (see the last step).

**Keep it private.** With the harness on the internet, anyone who finds its address could use your API credit. The Docker setup won't start without a password (`HARNESS_PASSWORD`), and the steps below reach it through Tailscale, a free private network between your own devices, so the server needs no open ports.

### Steps

1. **Create the server.** In Oracle Cloud: Create instance, image **Ubuntu 24.04**, shape **VM.Standard.A1.Flex** (1 or 2 CPUs and 6 to 12 GB is plenty). Save the SSH key it offers. Leave the network settings as they are; don't open port 3000.
2. **Connect to it** from PowerShell (Windows has `ssh` built in), using the key you saved and the server's public IP:
   ```powershell
   ssh -i C:\path\to\ssh-key.key ubuntu@SERVER_IP
   ```
   Everything below runs in that window, on the server.
3. **Install Docker and Tailscale.** Run these, then follow the link `tailscale up` prints to sign in:
   ```bash
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker $USER
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```
   Type `exit` and connect again (step 2) so the Docker permission applies.
4. **Get the harness and fill in `.env`:**
   ```bash
   git clone https://github.com/skyfly200/custom-ai-harness.git
   cd custom-ai-harness
   cp .env.example .env
   nano .env
   ```
   Fill in your API keys as on your PC, and set `HARNESS_PASSWORD` (a password of your choice) and `LITELLM_MASTER_KEY` (any text starting with `sk-`). Save with Ctrl+O, Enter, then Ctrl+X.
5. **Start it:**
   ```bash
   docker compose up -d --build
   ```
   The first build takes a few minutes. It starts again on its own after a reboot.
6. **Open it from your PC.** Install Tailscale on your PC (and phone, if you like) and sign in with the same account. Then open `http://SERVER_NAME:3000/ui`, where `SERVER_NAME` is the server's name in the Tailscale app. The browser asks for a user name and password: type anything as the user name and your `HARNESS_PASSWORD` as the password.
7. **Point Claude Code at it,** the same as on your PC but with the server's address and your password:
   ```powershell
   $env:ANTHROPIC_BASE_URL = "http://SERVER_NAME:3000"
   $env:ANTHROPIC_AUTH_TOKEN = "your HARNESS_PASSWORD"
   $env:CLAUDE_CODE_AUTO_MODE_SERVER = "0"
   claude
   ```
   Other tools use `http://SERVER_NAME:3000/v1` with the password as their API key.

### On Google Cloud's free tier instead

The same steps work on Google Cloud's free e2-micro server, with these changes:

- **Step 1:** in Compute Engine, create a VM with machine type **e2-micro** in **us-west1, us-central1 or us-east1** (the only free regions), image **Ubuntu 24.04**, and boot disk **Standard persistent disk, 30 GB or less**. Leave "Allow HTTP/HTTPS traffic" unticked.
- **Step 2:** use the **SSH** button next to the VM in the Google Cloud console instead of PowerShell.
- **Before step 5, add swap.** With 1 GB of memory, installing LiteLLM can run out of memory and stop. These lines add 2 GB of swap (disk used as spare memory), and it stays after a reboot:
  ```bash
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
  sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
  ```
- **Watch the data allowance.** The free tier includes 1 GB a month of data leaving Google, and every request the harness sends on to OpenRouter counts. Claude Code requests are large (often 100 KB to 1 MB each), so daily use can go over; Google then charges a small amount per GB. Check **Billing** in the console after a week. Oracle's free tier allows 10 TB a month, so it's the better pick for heavy use.

### Looking after it

All of these run on the server, inside the `custom-ai-harness` folder:

| To | Run |
|----|-----|
| See what it's doing | `docker compose logs -f` (Ctrl+C to stop watching) |
| Apply a model or fallback change from the Routing page | `docker compose restart gateway` |
| Update to the latest version | `git pull`, then `docker compose up -d --build` |
| Stop it | `docker compose down` |
| Apply a change to `.env` | `docker compose up -d --build` |

Your settings, usage numbers and `mcp-servers.json` live in the `data` folder. Chat can link repos you clone into the `repos` folder: clone one there and link it in chat as `/repos/NAME`. MCP servers started with `npx` work; ones that need `uvx` or other programs don't, because the container doesn't include them.


### Choose how it works

Lines you add to `.env` decide how the server works. Leave them all out and you get the setup above: Jev through OpenRouter picks between a strong and a cheap model for each request. After changing `.env`, run `docker compose up -d --build`.

**How it decides which model answers** (`HARNESS_MODE`):

| `.env` line | What it does | Memory |
|---|---|---|
| _(none)_ or `HARNESS_MODE=jev` | Jev through OpenRouter judges each request (uses `OPENROUTER_API_KEY`) | about 450 MB |
| `HARNESS_MODE=laya` | Laya judges each request on the server itself, with no outside call. Its model downloads on the first request | 2 GB or more |
| `HARNESS_MODE=routellm` | RouteLLM's BERT model judges each request on the server | 2 GB or more |
| `HARNESS_MODE=llm` | A chat model judges each request (GPT-4o mini through OpenRouter; `ROUTER_MODEL=` picks another) | about 450 MB |
| `HARNESS_MODE=passthrough` | No judging and no prompt changes: every request goes straight to one model, set with `PASSTHROUGH_MODEL=`. Use this to give another app or tool a plain API address | about 450 MB |

**Which models it picks between.** Use any model name from `config.yaml` or the Routing page:

```bash
STRONG_MODEL=fast-openrouter                   # hard requests (default local-engine: your local engine, then backups)
STRONG_MODEL_TOOLS=fallback-openrouter-tools   # hard requests from Claude Code and other tool-using agents (default: STRONG_MODEL)
WEAK_MODEL=fallback-groq                       # easy requests
WEAK_MODEL_TOOLS=fallback-openrouter-tools     # easy requests from tool-using agents
```

`fallback-openrouter-tools` is NVIDIA Nemotron 3.5 Super VL on OpenRouter: free, and it calls tools. Setting both `*_TOOLS` lines to it sends every Claude Code and agent request to a free model.

**A plain API address for another app** (passthrough):

```bash
HARNESS_MODE=passthrough
PASSTHROUGH_MODEL=fast-openrouter                        # a name from config.yaml, or a provider's own id:
# PASSTHROUGH_MODEL=openrouter/anthropic/claude-sonnet-5.5
# PASSTHROUGH_MODEL=openai/my-model                      # any OpenAI-style server, with:
# PASSTHROUGH_API_BASE=http://my-server:8000/v1
# PASSTHROUGH_API_KEY=its-key
```

The app then uses `http://SERVER_NAME:3000/v1` (OpenAI style) or `http://SERVER_NAME:3000` (Anthropic style) with your `HARNESS_PASSWORD` as its API key. Whatever model name the app asks for, the answer comes from `PASSTHROUGH_MODEL`.

**Local models with Ollama.** These run on the server's own processor, so they need a big server: 8 GB of memory or more for a 7B model, and they are slow without a graphics card.

```bash
COMPOSE_PROFILES=local
LOCAL_MODELS=qwen2.5-coder:7b gemma3:4b   # downloaded from ollama.com on first start
WEAK_MODEL_TOOLS=local-qwen2.5-coder:7b   # optional: send easy requests to one of them
```

Each model shows up as `local-NAME` for the settings above and in the chat page's model list. `fallback-ollama` in `config.yaml` uses the same Ollama. `docker compose logs -f ollama` shows the downloads.

**Your own local engine.** A llama.cpp or vLLM server on the same machine (`launch-local.sh`, changed to listen on `0.0.0.0` instead of `127.0.0.1`) is used as the strong model automatically. Another address goes in `LOCAL_ENGINE_URL=http://ADDRESS:8000`.

Settings in `.env` win over the Settings and Routing pages each time the server starts. Leave a setting out of `.env` to manage it from the Settings page instead.

---

## Reach it from your phone

To use Bright Chat from a phone, or any device that isn't yours, over `https://`, run a **Cloudflare tunnel**. It is a small program next to the harness that connects out to Cloudflare, which gives you a normal `https://` address that reaches the harness. Nothing on your router or server needs opening, and the address works for installing the app. [Tailscale](#run-it-on-a-server-docker) is the more private option, but the phone needs the Tailscale app; a tunnel only needs a browser.

**Set a password first.** A tunnel puts the harness on the internet, and anyone who finds the address could spend your API credit. Put `HARNESS_PASSWORD=` followed by a password of your own in `.env` before starting it. As a safety net the harness refuses requests that come through a Cloudflare tunnel while no password is set, and its controls (settings, clearing usage) never count a tunnelled request as "this machine".

### Try it with no account (a random address)

This gives an address like `https://random-words.trycloudflare.com` that changes each time you start it, which is enough to test from a phone.

- **Docker server:** add `COMPOSE_PROFILES=tunnel-quick` to `.env` (or `local,tunnel-quick` next to local models), run `docker compose up -d`, then `docker compose logs tunnel-quick` and look for the `trycloudflare.com` address.
- **Your Windows PC:** with the harness running (`npm run all`), install the tunnel program once with `winget install Cloudflare.cloudflared`, then run `cloudflared tunnel --url http://localhost:3000` in another PowerShell window and copy the `trycloudflare.com` address it prints. Close the window to close the tunnel.

Cloudflare doesn't promise quick tunnels stay up, so use a named tunnel for anything you rely on.

### A permanent address (free Cloudflare account and a domain)

1. In the Cloudflare dashboard go to **Zero Trust → Networks → Tunnels → Create a tunnel** and choose **Cloudflared**. Name it, then copy the **token** from the install command it shows (the long text after `--token`). Keep it private, like a password.
2. Under **Public hostname**, add a hostname on your domain (for example `chat.example.com`) and set the service to `HTTP` and `harness:3000` (use `localhost:3000` if the tunnel program runs on your PC instead of in Docker).
3. Add to `.env`: `TUNNEL_TOKEN=` followed by the token, and `COMPOSE_PROFILES=tunnel`. Then run `docker compose up -d`.
4. Open `https://chat.example.com/ui/chat.html` on your phone. The browser asks for a user name (anything) and your `HARNESS_PASSWORD`.

**Cloudflare Access (optional, recommended).** In **Zero Trust → Access → Applications**, add a self-hosted application for the same hostname and allow only your own email. Cloudflare then asks you to sign in before the harness's own password prompt, so strangers never reach it. The catch: Claude Code and other tools can't sign in through that page, so either leave Access off and rely on the password for them, or give them a service token (Cloudflare's docs call this a "service token" policy) and set it with `ANTHROPIC_CUSTOM_HEADERS`.

### Phone test checklist

For the full manual validation checklist, see [docs/hand-testing.md](./docs/hand-testing.md). It covers the real phone checks for password flow, installability, offline behavior, dashboard fit, voice, resume-after-lock, and unauthenticated status access.

## Technical reference

Everything below is the detail behind the quick start: how each part works, every setting, and how to run the tests.

The [technical roadmap](ROADMAP.md) has four phases, all implemented:

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Architecture Stabilization & Core Routing | ✅ |
| 2 | Intelligent Complexity Routing (RouteLLM & BERT) | ✅ |
| 3 | Zero-Cost Token & Context Compression | ✅ |
| 4 | Local Model Resilience & Anti-Looping | ✅ |

## Architecture

```
[ Coding Agent / Claude Code / Cursor ]
        │
        ▼  Port 3000 — Node.js interceptor (server.js)
        │  • Loads .env via dotenv
        │  • Injects Caveman compression prompt
        │  • Context anchor: replaces repeated tool results with pointers
        │  • Headroom: compresses tool outputs & file payloads
        │  • Derives complexity threshold from the latest typed request
        │  • Asks the Router which model to use, rewrites the model name
        │  • Accepts OpenAI (/v1/chat/completions) and Anthropic (/v1/messages)
        │
        │  ◄──► Port 6060 — Router (router.py): local RouteLLM BERT classifier,
        │                   answers "strong or weak?" and nothing else
        │
        ├─(complex)──────────► Port 4000 — LiteLLM → Tier 1 local engine (port 8000)
        │                                          → OpenRouter free-tier
        │                                          → Groq GPT-OSS 120B
        │
        ├─(simple, < 7K tok)─► Port 4000 — LiteLLM → Groq GPT-OSS 120B (free tier)
        │                                          → OpenRouter free-tier
        │
        └─(simple, larger)───► Port 4000 — LiteLLM → OpenRouter free-tier
                               (Groq's free tier caps requests at 8K tokens/min;
                                every Claude Code request is larger)
```

---

## Files

| File | Purpose |
|------|---------|
| `server.js` | Node.js interceptor — Caveman injection, Headroom compression, RouteLLM model routing |
| `config.yaml` | LiteLLM proxy — model list, fallback chain, port 4000 |
| `router.py` | Router — local BERT classifier service; picks the strong or weak Gateway model |
| `routellm-config.yaml` | Router — BERT checkpoint and strong/weak Gateway model names |
| `.env.example` | Environment variable template — copy to `.env` and fill in keys |
| `mcp-servers.example.json` | MCP servers for the chat page — copy to `mcp-servers.json` (see [Chat tools](#chat-tools-mcp-servers-and-git-repos)) |
| `launch-local.sh` | Hardened launcher for llama.cpp / vLLM local engines |
| `launch-laya.sh` | CPU launcher for the self-hosted Laya server the Router classifies with |
| `caveman-compress.js` | Standing context trimmer for `CLAUDE.md`, `.qwen/settings.json` |
| `validate-config.js` | UTF-8 / non-breaking space validator for config directories |
| `docker-compose.yml`, `Dockerfile`, `docker/` | The three parts as containers, for a server, plus the task runner as a fourth (`COMPOSE_PROFILES=runs`) (see [Run it on a server](#run-it-on-a-server-docker)) |
| `utils/access.js` | The optional `HARNESS_PASSWORD` login |
| `utils/login.js`, `utils/users.js`, `ui/users.html`, `scripts/hash-password.js` | Named logins with admins (see [Named logins](#named-logins-with-admins-harness_require_login)) |
| `guard-rules.json`, `utils/guard.js`, `.claude/hooks/guard.js` | The command guard (see [Command guard](#command-guard-jev-checks-commands-before-they-run)) |
| `scripts/jev-files-mcp.js`, `utils/jevFiles.js`, `utils/jevAsk.js` | The `ask_jev_file` tools (see [Ask Jev about a file](#ask-jev-about-a-file-ask_jev_file-tools)) |
| `workflows/`, `utils/workflows.js` | Recipes for the task runner and Jev's pick between them |
| `runner/`, `ui/runs.html` | The task runner: sandbox, tools, agent loop, run manager and API (see [Task runner](#task-runner-agents-that-do-a-whole-task)) |
| `ui/manifest.webmanifest`, `ui/sw.js`, `ui/icon*.svg`, `ui/icon-*.png` | The installable app: manifest, offline copy of the pages, icons (re-render the PNGs from the SVGs if the logo changes) |

---

## Prerequisites

- **Node.js** 18+
- **Python** 3.10+
- **llama.cpp** or **vLLM** (optional — only needed for a local Tier 1 engine)

---

## Installation

### macOS / Linux

```bash
git clone https://github.com/skyfly200/custom-ai-harness.git
cd custom-ai-harness

# Node dependencies
npm install

# Python virtual environment
python -m venv .venv
source .venv/bin/activate
pip install "litellm[proxy]" routellm

# Environment variables
cp .env.example .env
# edit .env and fill in your API keys
```

### Windows (PowerShell)

```powershell
git clone https://github.com/skyfly200/custom-ai-harness.git
cd custom-ai-harness

# Node dependencies
npm install

# Python virtual environment
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install "litellm[proxy]" routellm

# Environment variables
Copy-Item .env.example .env
# edit .env and fill in your API keys
notepad .env
```

> **PowerShell execution policy** — if `Activate.ps1` is blocked, run:
> ```powershell
> Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
> ```

---

## Configuration

### Environment variables

API keys are loaded from `.env` automatically when `npm start` runs. Copy the template and fill in your values:

```
GROQ_API_KEY=your_groq_key
OPENROUTER_API_KEY=your_openrouter_key
ANTHROPIC_API_KEY=your_anthropic_key   # optional
```

`HARNESS_PASSWORD` is optional on your own PC and required by the Docker setup. When set, every page and API asks for it: browsers show a login box (any user name), and agents send it as their API key (`Authorization: Bearer`, `x-api-key`) or in an `x-harness-password` header. The harness doesn't pass it on to the Gateway. It also lets the Settings page's controls work from other machines, which otherwise answer only on the machine the harness runs on.

### OpenRouter without a long-lived key (workload identity federation)

If your OpenRouter organization is on the Business or Enterprise plan, you can skip `OPENROUTER_API_KEY` and let the harness sign in the way [OpenRouter's workload identity federation](https://openrouter.ai/docs/guides/overview/auth/workload-identity-federation) describes: it sends a JWT from your own identity provider (a CI job, a Kubernetes service account, a cloud service account) to OpenRouter and gets back an access token that lasts 15 minutes. The harness asks for a new one a minute before it runs out, so a key that expires or leaks stops being a problem. The static key still works; federation is used only when `OPENROUTER_FEDERATION_POLICY_ID` is set (and then `OPENROUTER_API_KEY` is ignored).

**In OpenRouter** (an org admin, Settings → Workload identity): add your identity provider as an *issuer*, then add a *policy* with the audience your JWT carries, a subject or CEL condition, and the workspace API key it should act as. Copy the policy's id.

**In `.env`:**

```
OPENROUTER_FEDERATION_POLICY_ID=the-policy-id
# and exactly one way to get the identity provider's JWT:
OPENROUTER_FEDERATION_TOKEN_FILE=/var/run/secrets/tokens/openrouter   # re-read on every renewal
# OPENROUTER_FEDERATION_TOKEN_URL=http://metadata.google.internal/...  # a URL that returns the JWT, bare or as JSON
# OPENROUTER_FEDERATION_TOKEN_HEADERS=Metadata-Flavor: Google          # headers for that URL
# OPENROUTER_FEDERATION_TOKEN_COMMAND=my-idp-cli print-token           # a command that prints the JWT
```

Restart everything. The Interceptor does the exchange and uses the token for the model picker, read-aloud and prices. The Gateway (LiteLLM) and the Router (Jev) can only hold a fixed key, so with federation on they call OpenRouter through the Interceptor's `/openrouter-proxy`, which adds the current token. They prove themselves to it with `OPENROUTER_PROXY_KEY`, or `LITELLM_MASTER_KEY` when that is set; `npm run all` makes a random one if neither is. `GET /ui/api/status` shows `openrouter: { mode: "federation", ok, expiresInSec }` (never the token), and a failed exchange is logged with OpenRouter's reason (for example `invalid_grant: policy paused`).

**With Docker:** nothing else to change in `docker-compose.yml`; the Gateway and Router already reach the harness at `http://harness:3000` (`OPENROUTER_PROXY_URL` changes that). The harness container must be able to read the JWT, so use a file in a folder it has, such as `data/`:

```
OPENROUTER_FEDERATION_TOKEN_FILE=/app/data/idp-token
```

and have your identity provider's agent (or a cron job) write the JWT to `./data/idp-token`. `TOKEN_COMMAND` runs inside the container, where your tools aren't, so prefer a file or a URL there. Then `docker compose up -d --build`.

Not covered: the Router's own `OPENROUTER_API_KEY` is only swapped for URLs on `openrouter.ai`; an `ROUTER_BASE_URL` pointing at your own Laya server is untouched.

### Named logins with admins (`HARNESS_REQUIRE_LOGIN`)

For more than one person, or to give each program its own key, turn on logins. This replaces the single shared password: every page, `/ui/api` and `/v1` request then needs a signed-in user.

1. Make a hash for each admin's password (the password is typed hidden, and only the hash is stored):

   ```powershell
   npm run hash
   ```

2. Put the admins in `.env`, as `name:hash` pairs separated by commas, and turn logins on:

   ```
   HARNESS_REQUIRE_LOGIN=1
   HARNESS_ADMINS=alice:scrypt.16384.AbC...,bob:scrypt.16384.XyZ...
   ```

3. Start the harness. Browsers are sent to a sign-in page and stay signed in for 7 days. If logins are on and `HARNESS_ADMINS` is empty or malformed, the harness refuses to start rather than run open.

Admins open **Users** (the name at the top right of every page, or Settings → Users and API keys) to add and remove users, reset passwords, make other users admins, and make API keys. Only admins can open Settings or use the controls (settings, routing, runs); other users get chat, the dashboard, usage, and the API. Programs sign in with a key instead of a password: set Claude Code's `ANTHROPIC_AUTH_TOKEN` (or an OpenAI-style app's API key) to a key made on the Users page. HTTP Basic with a user name and password also works for programs that can't send a key. Keys and passwords are never passed on to the Gateway.

Users and keys are kept in `users.json` (`HARNESS_USERS_FILE`, in `./data` with Docker; it is gitignored and written private). Passwords and keys are stored only as hashes: a password with scrypt, a key with SHA-256 (keys are long random strings, shown once). Admins from `HARNESS_ADMINS` are changed in `.env`, not in the app. After 5 wrong passwords from one address or for one user name, sign-in waits 15 minutes. The session cookie is HttpOnly and SameSite=Lax, and Secure when the request came in over https (a tunnel or proxy). `HARNESS_PASSWORD`, if also set, keeps working as an admin key.

`ARTIFICIAL_ANALYSIS_API_KEY` is optional: a free key from [Artificial Analysis](https://artificialanalysis.ai/) fills in each model's quality, coding and speed numbers on the Routing page (fetched once a day).

`LITELLM_MASTER_KEY` is optional. Set it to require a key on the Gateway and to log in to LiteLLM's admin UI at http://localhost:4000/ui (username `admin`, the key as the password). LiteLLM reads it from `.env` too, as long as LiteLLM is installed in this repo's `.venv` as shown above (LiteLLM looks for `.env` in the folders above its own install, not the folder you start it from). If LiteLLM is installed somewhere else, set the variable in the shell before starting it. The harness then sends the master key on every call it forwards to LiteLLM, so clients such as Claude Code keep working with whatever key they already use. Generate one with:

```bash
python -c "import secrets; print('sk-' + secrets.token_urlsafe(32))"
```

The Docker launch settings (`HARNESS_MODE`, `STRONG_MODEL`, `PASSTHROUGH_MODEL`, `LOCAL_MODELS`, ...) are described in [Choose how it works](#choose-how-it-works) and `.env.example`. `router.py` and the Interceptor read them outside Docker too (except passthrough, which needs the Docker Gateway): `HARNESS_MODE`, `ROUTER_*`, `STRONG_MODEL` and the `WEAK_MODEL*` variables override `routellm-config.yaml`; `PIN_MODEL`, `HARNESS_TRANSFORMS=on|off` and `ROUTER_DOWN_MODEL`/`ROUTER_DOWN_TOOLS_MODEL` override the Settings page. `docker/gateway-start.py` applies `PASSTHROUGH_*`, `LOCAL_MODELS`, `OLLAMA_URL` and `LOCAL_ENGINE_URL` to a copy of `config.yaml` when the Gateway container starts.

Keys can also be set in the shell session if preferred:

**macOS / Linux**
```bash
export GROQ_API_KEY=your_groq_key
export OPENROUTER_API_KEY=your_openrouter_key
```

**Windows (PowerShell)**
```powershell
$env:GROQ_API_KEY = "your_groq_key"
$env:OPENROUTER_API_KEY = "your_openrouter_key"
```

### `config.yaml`

Defines the LiteLLM model list and fallback chain. The fallback order for every strong-model request is:

```
local-engine → fast-openrouter (GPT-4o mini, paid) → fallback-openrouter-tools (Nemotron 3.5 Super VL, free) → fallback-openrouter (Xing 4.0, free) → fallback-groq (GPT-OSS 120B)
```

`local-engine` is your own llama.cpp or vLLM server on port 8000 (`launch-local.sh`), running whichever model you loaded. It used to be called `claude-sonnet-5` and `claude-3-5-sonnet`, though it was never a Claude model; saved strategies, settings and Router configs that still use those names reach `local-engine`.

The OpenRouter backups are named free models, not `openrouter/free`. That one picks a free model at random for each request, and its pool includes NVIDIA's content-safety classifier, which answers "User Safety: safe / Response Safety: ..." instead of replying. Free models come and go on OpenRouter (Llama 3.3 70B `:free` lost its last provider in October 2026), so if a backup starts failing every call, pick another in the routing page's **Add model** list with the **Free** filter.

LiteLLM gives each model `request_timeout` (120 s) before it moves to the next one, and `router_settings.num_retries: 0` makes it move on at once after a rate limit instead of waiting to retry a spent quota.

Deprecated Llama 3/3.1 variants are intentionally absent. Groq serves GPT-OSS 120B: its free tier gives it the same limits as the 20B (8K tokens/min, 1K requests/day), so the bigger model costs nothing extra.

Each deployment sets `max_parallel_requests` (local engine 1, Groq 3, OpenRouter 5), so bursts queue in the Gateway instead of tripping provider rate limits.

### `routellm-config.yaml`

Configures `router.py`: the local RouteLLM `bert` checkpoint (no external embedding API key needed) and the Gateway model names it picks between. The Router only classifies; the Interceptor then sends the request to the Gateway on port 4000 itself.

RouteLLM's bundled `openai_server` is not used: it rejects tool schemas, can't carry the Anthropic format, and needs an `OPENAI_API_KEY` even for BERT.

#### Choosing a classifier: `backend:`

Every backend turns the prompt into the strong model's win rate in [0, 1]; the threshold and overflow rules are the same for all of them. Set one in `routellm-config.yaml` (the file has a commented block for each):

| `backend:` | What scores the prompt | Keys it reads | Install |
|---|---|---|---|
| `routellm` (default) | RouteLLM BERT, in-process | `checkpoint` | `pip install routellm` |
| `laya` | [Laya](https://github.com/NandhaKishorM/laya), in-process: P(yes) for "does this need a strong model?" | `laya_max_chars` (2000), `laya_preload` (false) | `pip install -r requirements-laya.txt` |
| `systemone` | A server speaking the Jev `POST /v1/systemone` protocol: TypeSafe Jev, or a local `laya-serve` | `base_url`, `api_key_env`, `auth_header` (Authorization), `model`, `max_chars` (2000), `timeout` (10) | `pip install httpx` |
| `llm` | Any OpenAI-compatible `/chat/completions` model asked to rate difficulty 0 to 1; `<think>` blocks are ignored | `base_url`, `model`, `api_key_env`, `max_tokens` (2048), `max_chars` (4000), `timeout` (30) | `pip install httpx` |
| `custom` | Your `factory(config)` returning `prompt -> float` | `scorer: "package.module:factory"` | |

`api_key_env` names the environment variable holding the key, so the key itself never goes in the file. For example, Jev:

```yaml
backend: systemone
base_url: https://openrouter.ai/api   # Jev via OpenRouter, or http://localhost:8001 for laya-serve (launch-laya.sh)
api_key_env: OPENROUTER_API_KEY
model: jev-latest
```

`GET /health` on the Router reports which backend is running.

---

## Running the stack

Open four terminal sessions (or use a process manager like `pm2` / `tmux`).

### 1. Local engine _(optional — skip if routing entirely to cloud fallbacks)_

**macOS / Linux**
```bash
# Qwen Coder
./launch-local.sh qwen models/qwen2.5-coder-7b-instruct-q5_k_m.gguf

# Gemma 4
./launch-local.sh gemma models/gemma-4-9b-it-q5_k_m.gguf
```

**Windows (PowerShell)**
```powershell
# llama.cpp must be on PATH or provide the full path to llama-server.exe
# Qwen Coder
llama-server --model models\qwen2.5-coder-7b-instruct-q5_k_m.gguf `
             --ctx-size 8192 --n-gpu-layers 99 --threads 8 `
             --host 127.0.0.1 --port 8000 --no-mmap

# Gemma 4
llama-server --model models\gemma-4-9b-it-q5_k_m.gguf `
             --ctx-size 8192 --n-gpu-layers 99 --threads 8 `
             --host 127.0.0.1 --port 8000 --no-mmap
```

### 2. LiteLLM proxy (port 4000)

**macOS / Linux**
```bash
source .venv/bin/activate
litellm --config config.yaml
```

**Windows (PowerShell)**
```powershell
.\.venv\Scripts\Activate.ps1
$env:PYTHONUTF8 = 1   # LiteLLM's startup banner crashes on a non-UTF-8 console
litellm --config config.yaml
```

#### LiteLLM admin UI database (optional)

You don't need this to run the harness: the [Control UI](#control-ui) covers health, routing and fallbacks. LiteLLM's own admin UI at http://localhost:4000/ui logs in with just `LITELLM_MASTER_KEY`, but its pages (virtual keys, users, spend) show "Not connected to DB" until LiteLLM has a Postgres database. To add one with Docker:

```bash
docker run -d --name litellm-db -e POSTGRES_PASSWORD=litellm -p 5432:5432 postgres:16
```

Then add the connection string to `.env`, install Prisma in the venv, and restart LiteLLM, which creates its tables on startup:

```
DATABASE_URL=postgresql://postgres:litellm@localhost:5432/postgres
```

```bash
pip install prisma
```

### 3. Router (port 6060)

**macOS / Linux**
```bash
source .venv/bin/activate
python router.py
```

**Windows (PowerShell)**
```powershell
.\.venv\Scripts\Activate.ps1
python router.py
```

#### Router classifier: Jev through OpenRouter

`routellm-config.yaml` points the Router at TypeSafe's [Jev on OpenRouter](https://openrouter.ai/typesafe) (`backend: systemone`, `base_url: https://openrouter.ai/api`), which answers "does this request need a strong model?" with nothing to run locally. It uses the same `OPENROUTER_API_KEY` as the Gateway; the Router reads it from `.env` like the Interceptor does. Jev bills per input token, and the Router sends at most the last 2,000 characters of each request (`max_chars`).

If Jev errors or takes longer than `timeout` (5 s), the Router returns an error and the Interceptor sends the request to `fallback-openrouter`. To go back to the BERT classifier, set `backend: routellm`.

#### Running Laya locally (optional)

[Laya](https://github.com/NandhaKishorM/laya) is an open-source classifier that speaks the same protocol as Jev, so it can replace Jev with no API key or per-token cost. It runs on CPU.

1. Start the server on port 8001 (the Tier 1 local engine already uses 8000).

   **macOS / Linux**
   ```bash
   source .venv/bin/activate
   ./launch-laya.sh            # installs laya[serve] with CPU PyTorch on first run
   ./launch-laya.sh docker     # or: Laya's own CPU Docker image
   ```

   **Windows (PowerShell)**
   ```powershell
   .\.venv\Scripts\Activate.ps1
   pip install --index-url https://download.pytorch.org/whl/cpu torch
   pip install "laya[serve]"
   $env:LAYA_HOST = "127.0.0.1"; $env:LAYA_PORT = "8001"; $env:LAYA_DEVICE = "cpu"
   $env:LAYA_MODELS = "english"; $env:LAYA_PRELOAD = "1"
   laya-serve
   ```

   The first start downloads the English checkpoint from Hugging Face.

2. Wait until `curl http://127.0.0.1:8001/health` answers.

3. In `routellm-config.yaml`, set `base_url: http://127.0.0.1:8001` and comment out `api_key_env` and `model` (Laya rejects model names it does not serve).

4. Restart the Router. `GET http://localhost:6060/health` still reports `systemone`; the Router log shows connection errors if Laya is not running.

To run Laya on another machine, start it there with `LAYA_HOST=0.0.0.0 LAYA_API_KEY=<secret> ./launch-laya.sh`, set `base_url` to that machine, and set `api_key_env: LAYA_API_KEY` with the same key in `.env`.

### 4. Node.js interceptor (port 3000)

```powershell
npm start
```

Point an OpenAI-compatible assistant (Cursor, Aider, Continue, Cline) at `http://localhost:3000/v1`.

### Using Claude Code through the harness

`npm run claude` from the repo folder sets this up and starts Claude Code in one step; this is what it sets:

```powershell
$env:ANTHROPIC_BASE_URL = "http://localhost:3000"
$env:ANTHROPIC_AUTH_TOKEN = "local-harness"   # dummy; keeps your real Anthropic credentials off the local stack
$env:CLAUDE_CODE_AUTO_MODE_SERVER = "0"       # auto mode: skip server-side checks the harness can't carry
claude
```

The Interceptor routes each request and the Gateway translates the Anthropic Messages format for whichever model serves it, including tool use and streaming. The Interceptor log shows each routing decision.

**Auto mode.** Claude Code's auto mode asks Anthropic's server to run its safety checks inside each request, but the harness rewrites requests and sends them to non-Anthropic models, so those checks never reach the session. `CLAUDE_CODE_AUTO_MODE_SERVER=0` tells Claude Code to use its own classifier requests from the start instead of stopping at the first checked action with an "isn't eligible" notice. Those classifier requests also go through the Interceptor and are routed like any other request, so the Gateway model that serves them judges whether an action is safe. See [Auto mode classifier request charges](https://code.claude.com/docs/en/auto-mode-classifier-billing).

### Command guard (Jev checks commands before they run)

The harness can check each shell command and file write an agent is about to run. `.claude/hooks/guard.js` is a Claude Code `PreToolUse` hook that sends the command to `POST /v1/guard` and passes the answer back:

- **Rules first.** `guard-rules.json` lists patterns that block a command (`rm -rf /`, a force push to `main`, writing to a disk, sending `.env` to the internet, editing `.git/` or SSH keys) or make the agent ask you first (any recursive delete, other force pushes, `git reset --hard`, `curl … | sh`, overwriting `.env`, `DROP TABLE`). No model is called for these. To change them, copy the file to `guard-rules.local.json` (gitignored), edit it, then reload with `POST /ui/api/guard/reload` or restart the Interceptor.
- **Read-only commands pass.** `ls`, `cat`, `git status`, `git diff` and the like skip the check, unless something is redirected into a file.
- **Jev for the rest.** Other commands go to the Router's `POST /ask`, which asks Jev (the `systemone` or `laya` backend) two yes/no questions: is it destructive or hard to undo, and does it send secrets out. At 50% or more the agent has to ask you. Jev never blocks on its own unless you set **Guard: block from** on the Settings page. If Jev can't be reached the command goes ahead and your normal Claude Code permissions still apply.
- **"Allow" never approves.** The hook stays silent then, so your usual permission settings decide.

Every decision shows in the Dashboard's **Command guard** table. To turn the hook on for every project, add this to `~/.claude/settings.json` (use the full path to your copy of the repo; on Windows write it with forward slashes):

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit",
        "hooks": [{ "type": "command", "command": "node C:/path/to/custom-ai-harness/.claude/hooks/guard.js" }] }
    ]
  }
}
```

`HARNESS_GUARD_URL` points the hook at another harness (default `http://localhost:3000/v1/guard`), and `HARNESS_PASSWORD` is sent when set. If the harness isn't running the hook lets commands through; set `HARNESS_GUARD_STRICT=1` to have Claude Code ask you instead. Other agents can call the endpoint directly:

```bash
curl -s localhost:3000/v1/guard -H 'content-type: application/json' -d '{"tool":"Bash","command":"git push --force origin main"}'
# {"decision":"deny","reason":"Force push to a protected branch","rule":"force-push-main",...}
```

### Ask Jev about a file (`ask_jev_file` tools)

Agents often open a big file just to learn one fact about it. `scripts/jev-files-mcp.js` is an MCP server that lets them ask Jev instead: it reads the file on your machine, has Jev answer, and returns one line, so the file never enters the agent's context.

| Tool | Use it for | Answer |
|---|---|---|
| `ask_jev_filebool` | "Does this file read environment variables?" | `yes` or `no`, Jev's confidence, roughly which line |
| `ask_jev_filescale` | "This code is hard to follow" (a statement to rate) | a number from 0 to 1 |
| `ask_jev_files` | the same yes/no question about up to 20 files | only the files that say yes, strongest first |

Add it to Claude Code (use the full path to your copy of the repo):

```bash
claude mcp add jev-files -- node /path/to/custom-ai-harness/scripts/jev-files-mcp.js
```

The chat page can use it too: copy `mcp-servers.example.json` to `mcp-servers.json`; its `jev-files` entry is already on.

How it behaves:

- **It needs the Router on `systemone` (Jev) or `laya`.** Other backends can't answer questions and the tools return an error.
- **Long files are read in parts.** Jev reads as much at once as the Router's `max_chars` setting (2,000 characters by default), so a file is cut into parts of that size, each part is asked the same question, and the strongest answer wins, so one hit anywhere counts. At most 12 parts are read; the reply says when a file was only partly read. Raise `max_chars` on the Settings page if your Jev takes more.
- **Only some files can be sent.** The tool server reads files only inside the folder it was started in, or the folders in `HARNESS_FILE_ROOTS` (separated by `:`, or `;` on Windows). It refuses `.env` and other secrets files, SSH keys, binaries and files over `HARNESS_FILE_MAX_BYTES` (2 MB), because the text goes to Jev's host.
- **It costs one Jev call per part.** Nothing is cached yet.
- `HARNESS_URL` (default `http://localhost:3000`) and `HARNESS_PASSWORD` tell the tool server where the harness is. Other programs can call `POST /v1/jev/ask` directly with `{"text", "question", "mode": "bool" | "scale"}`.

### Task runner (agents that do a whole task)

The **Runs** page gives an agent a goal, such as "fix the failing test in `utils/tiers.js`", and lets it work until it is done. The agent reads and edits files and runs commands in its own copy of your repo, using the models your routing picks. When it finishes you get a summary and the changes.

How it keeps your work safe:

- **Its own branch.** Each run is a `git worktree` of your repo on a new branch named `harness/<id>`, or (with `RUNNER_SANDBOX=e2b`) a [cloud sandbox](#cloud-sandboxes-e2b) that gets the same branch. Your checked-out files are never touched. Review the branch with `git diff <start>..harness/<id>` (the page shows the exact command) and push it yourself if you like. Nothing is ever pushed or published for you.
- **Every command and file write goes past the [command guard](#command-guard-jev-checks-commands-before-they-run).** Dangerous ones are refused, risky ones wait on the Runs page for you to **Allow** or **Decline** (no answer for 15 minutes counts as decline), and an unreachable guard counts as "ask".
- **Only chosen folders.** Repos must be inside `RUNNER_ROOTS` (default the `repos` folder next to the harness; set it in `.env`, separating folders with `;` on Windows). Files the agent reads and writes must stay inside its workspace, and `.git` is off limits.
- **One working tree per chat.** Linking a repo to a chat gives it a persistent `git worktree` on its own `harness/chat-…` branch. Chats linked to the same repo therefore do not share uncommitted edits or shell commands, and the original checkout is left alone. A chat's worktree starts at the linked repo's current `HEAD`; it does not copy uncommitted files from the original checkout. Worktrees are kept under `data/chat-worktrees` (or `CHAT_WORKTREES_DIR` if set) so the chat can resume in the same workspace later.
- **No keys.** Commands the agent runs get a trimmed environment, so they can't print the harness's API keys.
- **Faster local tool rounds.** Independent file and directory reads requested together run concurrently; writes and shell commands stay ordered. On Windows, local runs and the linked-repo shell reuse a PowerShell process, while starting each command back in the repository root. A run's shell closes when that run ends.
- **Plan mode.** Tick **Plan only, change nothing** on the form, or start one from a chat with `/plan TASK`. The agent reads and searches the repository but is offered no shell, write or edit tool, so it cannot change files or run commands. Its rules tell it to answer with the plan itself, and the run makes no commit. What comes back is the plan — what it would change file by file, the order, what to check after each step, and the risks or open questions. Read it, then start the same task without plan mode (or with an agent that has a different model) when you are happy. The Runs page marks such a run **Plan only** and hides the branch and diff, since there is nothing to review.
- **Limits.** Each run stops after its max minutes (30), and at most `RUNNER_MAX_RUNS` (2) run at once. **Max steps** is off by default (0), so a run goes on until the agent calls finish or its minutes run out; set a number to cap the model calls it may make (a workflow stage may also cap its own). **Stop** ends a run, even in the middle of a command.
- **Continue, retry and auto debug.** A run that only ran out of steps or time has **Continue**: the same run, the same `harness/<id>` branch, starting from the commits and the files the earlier part left (what it was saying when it ran out goes into the prompt), with a fresh set of minutes (and steps, if it was capped) rather than whatever was left of the old ones. Nothing went wrong, so it is not a new run and nothing is thrown away; continue it as often as it needs, and the page shows how many parts it took. With no step limit a run only ends this way on its minutes, which is what the default of 30 makes likely on a long task. A run that **failed** has **Retry run** (the same task again from the same commit, on a fresh `harness/<id>` branch) and **Auto debug**: the new agent is told what the earlier attempt got wrong (the error, the failing test output, the last tools it ran and what they returned) and is asked to work out the real cause instead of repeating it. Tick **Auto debug a failed run** on the form (or set `RUNNER_AUTO_DEBUG=1`) and the runner does that by itself, at most 2 generations deep, so a failure it cannot fix stops and waits for you. An earlier run's branch is not deleted, so you can compare the two.

To use it, run `npm run all` (it starts the runner as a fourth part), put a git repo in the `repos` folder or set `RUNNER_ROOTS`, open **Runs** from the top bar, describe the task and press **Start run**. Routing and Effort work as in chat: pick a routing, or **Jev picks (auto)**. Type or paste the repo's path, pick a recent one, or press **Browse…** to walk through the allowed folders (repos are marked ◆). The agent runs the project's tests itself when the task calls for it.

#### Workflows (recipes the agent follows)

A workflow is a short list of stages. Each stage is its own agent loop with a role, the tools it may use, a step budget and optionally an effort, and it is handed what the stages before it found. The recipes live in `workflows/*.json`, one file each:

| Workflow | Stages | Fits |
| --- | --- | --- |
| Quick answer | Explainer (read-only) | a question about the code |
| Fix a bug | Investigator (reads, runs tests), Implementer, Verifier | a bug report or failing test |
| Build a feature | Planner (high effort), Implementer, Verifier | new behaviour |
| Refactor | Planner (runs the tests first), Implementer, Verifier | restructuring without changing behaviour |
| Review | Reviewer, Skeptic (tries to disprove each finding) | "review this branch", changes nothing |
| Research the code | Reader, Writer | how something works, changes nothing |
| Do the task | Engineer | anything else (the fallback) |

Tool sets: `read` (list, read), `check` (also run commands) and `all` (also write files). A **Verifier** starts its summary with PASS or FAIL; FAIL sends the run back to the Implementer once, with what was wrong, and a second FAIL stops the run for you to look at.

On the Runs page the Workflow box is **Jev picks (auto)** by default. A moment after you stop typing the goal, Jev is asked one yes/no question per recipe ("Is this task a bug report, a failing test or an error message...?"), the best answer at 50% or more wins (otherwise "Do the task"), and the pick is shown under the box. Choose another workflow in the box to override it. To add your own recipe, copy a file in `workflows/`, change the `id`, `name`, `when` (the sentence Jev is asked about) and `stages`; a file with a mistake is skipped and listed by `GET /ui/api/workflows` under `problems`. Set `HARNESS_WORKFLOWS_DIR` to keep recipes elsewhere.

#### Swarm (several agents on one task)

Choose **Swarm (several agents at once)** in the Workflow box for a task that splits into separate parts. It runs in four steps:

1. A **Planner** (read-only, high effort) reads the repo and splits the goal into up to 5 parts that touch different files. If its plan can't be read, the whole task runs as one part.
2. A **worker** per part starts as an ordinary run (its own branch, its own approvals, the workflow the planner chose for it). They run side by side, as many as `RUNNER_MAX_RUNS` (default 2) allow, and the rest wait their turn.
3. Each finished branch is merged into the swarm's own branch `harness/<id>`. A part that fails, changes nothing or conflicts with another is left out and named in the summary; its branch stays in your repo.
4. A **Reviewer** runs the tests and checks that the combined result does the whole task.

The swarm's page lists its workers; click one to watch it or answer its approval. Stopping the swarm stops every worker. A swarm is marked finished only when every part merged and the reviewer said PASS. Raise `RUNNER_MAX_RUNS` for more workers at once (each one is a stream of model calls, so mind your rate limits).

Notes:

- The runner is its own process (`node runner/server.js`, port 3100, only reachable from this machine). The Interceptor passes the Runs page's requests to it after its own login check, and `npm run all` sets a shared `RUNNER_TOKEN` so nothing else on the machine can drive it. If you start the parts yourself, set the same `RUNNER_TOKEN` in `.env` for both.
- Run records are kept in `runs/` (gitignored). A run that was in progress when the runner stopped shows as failed; its branch keeps whatever was committed. The record is written to a temporary file and renamed into place; where Windows refuses the rename for a moment (a virus scanner or the indexer holding `run.json` open, `EPERM`) it retries, then writes in place, so a run is never lost to that.
- It runs under Docker with `COMPOSE_PROFILES=runs` (see [Cloud sandboxes](#cloud-sandboxes-e2b) for the setup), which on a server is how to use it.
- Tested with a scripted model, not with real models or on Windows (commands run in PowerShell there).

#### Cloud sandboxes (E2B)

A run can work in a sandbox in the cloud instead of a worktree on this machine: the agent's commands then run in a Linux VM from [E2B](https://e2b.dev), never on your PC. Set `RUNNER_SANDBOX=e2b` and `E2B_API_KEY` in `.env` (the key is on your E2B dashboard; get one from the free tier), keep the repo in `RUNNER_ROOTS` as usual, and start the runner as always. Nothing else changes: the same workflows, tools, guard and approvals apply, and the run page looks the same.

How the branch gets there and back:

1. The base commit of your repo is packed into a git bundle and written into a fresh sandbox (template `E2B_TEMPLATE`, default `base`), which checks it out on a branch `harness/<id>` of its own in `/home/user/work` (set `E2B_WORKDIR`).
2. The agent works there; every file call and command goes to the sandbox.
3. When the run ends, everything is committed and the branch is packed back into a bundle and fetched into your repo here, so `git diff`, **Continue**, **Retry** and pushing work exactly as with a local run. A swarm's own branch is handed back after its merges, and each worker's branch is handed *to* it before they are merged. A continued run gets a new sandbox holding its branch as it stands.
4. The sandbox is killed as soon as the run ends (and if the runner is restarted mid-run), so nothing keeps billing. Its record keeps the sandbox id.
5. On a Docker server, the runner is a container (`COMPOSE_PROFILES=runs`) whose commands all go to the sandbox; see below.

Notes:

- The cloud sandbox has no copy of your other branches, and `E2B_API_KEY` is never given to the commands the agent runs.
- The run's own record and the branch stay here, in `runs/<id>/run.json` and your repo; delete the run to remove the record.
- `apt-get install git` runs once in a new sandbox if the template has no git.
- Reading files, listing folders and running commands are network calls now, so a cloud run is slower per step than a local one; `MAX_OUTPUT` trimming and the run's step and minute limits work as before.

**On a Docker server.** The runner has its own container. Set these in `.env` on the server, then `docker compose up -d --build`:

```
COMPOSE_PROFILES=runs
RUNNER_TOKEN=any-long-random-text
E2B_API_KEY=e2b_...
RUNNER_SANDBOX=e2b            # the compose default for this container
```

The runner comes up beside the Interceptor (`http://runner:3100`, no ports published) and the Interceptor sends it the Runs page's requests with the same `RUNNER_TOKEN`, so nothing else on the network can drive it. Runs and their branches land in the `runs` and `repos` folders on the server, so **Continue**, **Retry** and `git diff` work as they do on your PC, and the branch is pushed from the server. Local mode is possible too but pointless there: the worktree is made from the copy of the repo in `repos`, and commands run inside the runner's image, which has only Node and git.

### Langfuse (see every call, grouped by chat or run)

[Langfuse](https://langfuse.com) records each model call the Gateway makes: which model, tokens, cost, how long it took, and (if you choose) the prompt and reply. The harness groups calls by chat (Bright Chat) or by run (Runs page), and tags each with the client, the model, the strategy, whether Auto picked it, and the user who was logged in. Claude Code calls are grouped by its own session id. **Nothing is sent unless you set both keys.**

1. Get keys: sign up at [cloud.langfuse.com](https://cloud.langfuse.com) (free tier), make a project, then Settings, API Keys. Or run your own, below.
2. Add them to `.env`:

   ```
   LANGFUSE_PUBLIC_KEY=pk-lf-...
   LANGFUSE_SECRET_KEY=sk-lf-...
   LANGFUSE_HOST=https://us.cloud.langfuse.com   # only if your project is on the US cloud
   ```
3. Install the logger once into the `.venv` (Docker does this for you): `pip install langfuse`.
4. Restart. With `npm run all` the Gateway then starts through `docker/gateway-start.py`, which writes `.gateway-config.yaml` (your `config.yaml` plus the Langfuse callbacks; `config.yaml` itself is not touched). With Docker, `docker compose up -d --build`.

The Settings page shows a Langfuse box: off, connected (with a link to open it), or what is wrong (keys refused, unreachable).

**What is logged.** By default only metadata: model, tokens, cost, timing, tags. The text of your prompts and replies (which can include your code and files) stays out. To log it as well, tick "Langfuse: also log prompts and replies" on the Settings page; it applies from the next request, no restart. Or set `LANGFUSE_LOG_CONTENT=1` in `.env` as the starting value. The Gateway redacts text by default, so programs that call the Gateway directly (port 4000) are never logged with content.

**Your own Langfuse in Docker.** Needs about 3 GB of RAM (too much for a 1 GB server; use the cloud there). In `.env`:

```
COMPOSE_PROFILES=langfuse
LANGFUSE_HOST=http://langfuse-web:3000
LANGFUSE_URL=http://localhost:3001
LANGFUSE_SALT=any-long-random-text
LANGFUSE_ENCRYPTION_KEY=...            # openssl rand -hex 32
LANGFUSE_PUBLIC_KEY=pk-lf-harness      # you choose these; they are created on first start
LANGFUSE_SECRET_KEY=sk-lf-harness-change-me
LANGFUSE_INIT_USER_EMAIL=you@example.com
LANGFUSE_INIT_USER_PASSWORD=choose-a-password
```

Then `docker compose up -d --build` and open http://localhost:3001. The first start takes a minute or two. Combine with other profiles with commas (`COMPOSE_PROFILES=local,langfuse`).

### Control UI

The web app is called **Bright Chat**. Its pages draw a slowly turning "embedding space" in the background: words with similar meanings sit in clusters, and the mouse acts as a query that lights up its nearest neighbours. The dots-and-lines button at the end of the page links turns it off (your choice is kept in the browser). On the Chat page it starts off so chats stay fast; the same button turns it on there, and it stays still when Windows or your browser asks for reduced motion (Windows: Settings → Accessibility → Visual effects → Animation effects).

With the Interceptor running, open <http://localhost:3000/ui>. The dashboard refreshes every 3 seconds and shows:

- **Components**: whether the Router, Gateway, local engine (port 8000), Ollama (11434) and a local Laya (8001) answer, and which classifier the Router is using. The last three are optional and show as "not running" rather than down.
- **Counters** since the Interceptor started: requests, times the Router couldn't be reached, Gateway fallbacks, errors, rate-limited requests and timeouts.
- **Recent chats**: the latest chats saved in this browser, with their project; click one to open it on the chat page.
- **Usage, last 7 days**: spend, requests (and how many were free), tokens, and the models that used the most, from the same totals as the Usage page.
- **Recent routing decisions**: the model each request went to and why (win rate against threshold, tool requests, a pinned model, or the Router being down), the Gateway's status and time to first byte, how many fallbacks LiteLLM tried and which model group answered (from LiteLLM's `x-litellm-attempted-fallbacks` and `x-litellm-model-group` headers, when your LiteLLM version sends them), and the start of the typed request. A failed request shows why: **rate limit** (a 429 or a provider quota message, quoted), **timeout**, **gateway down**, or **stopped** when the client cancelled it.

<http://localhost:3000/ui/settings.html> (**Settings** in the menu) holds the settings that used to sit on the dashboard:

- **Interceptor settings**: pin every request to one model (skipping the Router), replace the keyword threshold with a fixed one, the output-token cap, the Router timeout, the Gateway timeout and the stalled-reply timeout (after which a request fails with an error instead of hanging), the models used when the Router is down, and switches for the caveman prompt, Headroom and the context anchor. They apply on the next request and are saved to `harness-settings.json` (gitignored); delete it or press "Reset to defaults" to go back.
- **Router settings**: the strong, weak, tool and overflow models, the weak model's size limit, the classifier backend and its settings (base URL, model, API key variable name, timeout, and so on). **Apply** lasts until the Router restarts; **Apply and save to file** also writes them to `routellm-config.yaml`, editing only those lines and keeping your comments (a cleared setting is commented out); **Reload from file** picks up edits you made by hand. A change that fails to build the classifier leaves the running one in place.

Model fields suggest the names from the Gateway's `/v1/models` (or `config.yaml` when the Gateway is down). The Gateway's own fallback chain still lives in `config.yaml`.

#### Chat

<http://localhost:3000/ui/chat.html> is a chat page that sends through the Interceptor like any other client, so the Router picks the model unless you name one. What it does:

- **Live progress.** Each reply shows its steps as they happen: the Router choosing, the model it picked and why, the transforms applied, the Gateway's answer (with fallbacks and the model that actually served it), time to first token and tokens per second. The **Activity** panel shows every request through the harness live, from this page and from other clients such as Claude Code, plus the health of each part. Both come from `/ui/api/live`, a Server-Sent Events feed of the routing log.
- **Chats.** Every chat is saved in the browser and listed on the left under **Recent**, newest first, with search. Alt+↑/↓ moves between chats, Ctrl+Shift+O starts a new one, Ctrl+K searches. A chat that is replying shows what it is doing in the list (routing, thinking, writing with a token count, or the tool it is using), and one that finished while you were elsewhere gets a dot. After the first reply, the model is asked for a short name for the chat (turn this off under Options → Model **Name new chats automatically**; type a title to rename it yourself). Hover a chat to show its × delete button, or use the trash button in the top bar, or **Delete all chats** under the list.
- **Projects.** The **+** next to *Projects* in the sidebar makes one: a name, a colour, instructions sent with every chat in it, skills that are on for every chat in it, and optionally a git repo its chats can read. Click a project to see only its chats; **New chat** then starts one inside it. Move a chat into or out of a project under Options → Context. The project's settings (the gear on hover, or its badge in the top bar) also show its total tokens and cost. Deleting a project keeps its chats.
- **Scheduled messages.** The **+** next to *Scheduled* sends a message at a set time, once or every hour, day, weekday or week, into a new chat each time (optionally in a project) or into an existing chat. They run while Bright Chat is open in a browser tab; a run missed while it was closed happens as soon as the page opens. **Run now** in a schedule sends it straight away.
- **Skills.** A skill is named instructions: a review checklist, a writing style, the steps for a task. The sparkle button in the message box lists them: tick one to turn it on for this chat. **Manage skills** adds and edits them (three examples are added the first time). **Let the model load other skills when it needs them** gives the model a `use_skill` tool and a list of your skills, so it can read one when a question matches; like any tool, this sends requests to tool-capable models.
- **Commands.** Typing `/` in the message box lists three commands the page handles itself, then your own, each with the model it sends to, and under them the tools this chat can use. **`/advisor MODEL`** sets a better model this chat's model may call for a second opinion: give it a short name (`/advisor opus` finds the newest Opus) or a full one, and from then on the chat's model has an `ask_advisor` tool it can hand a hard part to. The advisor answers in words, with no tools of its own, so the expensive model's part stays small; each call's cost is counted with the reply that made it. `/advisor` alone says what is set and `/advisor off` removes it; the composer says which advisor a chat has. A short name is matched to the newest model the Gateway serves, so "opus" means `claude-opus-5.5` and "opus-4.5" the one it names. **`/subagent TASK`** hands one task to an agent on its own branch while the chat carries on: it is an ordinary run, so it has its own page entry, approvals and diff, and follows the chat's repo, routing and effort. `/subagent MODEL TASK` gives it a model of its own; use this when a cheaper model can handle searching, fetching or a mechanical edit. **`/plan TASK`** starts a plan-only run: the agent reads the repo and writes down what it would change, in order, without changing files or committing. Your own commands are one message sent with a model, strategy or effort for that turn only, so the next message goes back to the chat's own routing. The panel's **Commands** button adds and edits them: a name, one line on what it does, the model or strategy, the effort, and the message, where `{args}` becomes what you type after the command (a command with no `{args}` gets it after its message). A command's turn carries no tools, since a model named there may not call them.
- **Queued messages and following a reply.** Type while a reply is still arriving and the message waits its turn instead of being dropped: the composer says how many are waiting, and **Clear** removes them. Scrolling up during a reply stops the conversation following the new text, so you can read what came before; a button at the bottom takes you back, and the chat follows again once you are at the end. Scrolling up inside a thinking pane holds that pane still in the same way. A reply that was still arriving when the page closed is marked as cut off, instead of its animation playing forever.
- **Stop, resend and frozen replies.** A reply in progress has a **Stop** button (or press Esc), and every message you sent has a resend button. The Interceptor already fails a request that gets no answer within 5 minutes or goes quiet for 2 (see `gatewayTimeoutMs` and `streamIdleTimeoutMs`); as a backstop, for example when the Interceptor itself stops answering, the page gives up after 310 and 130 seconds and offers Retry. Change both under Options → Model (0 waits forever). Free models often stall or return HTTP 429 once their daily or per-minute quota is used up, and the error says so.
- **Costs and context.** Each reply shows what it cost (`free` for free and local models), and the top bar shows the chat's tokens, total cost and how full the model's context window is for the next message. Click those numbers for a breakdown: a bar per reply (sent and written tokens), tokens and cost by model, the size of the next message against the model's context window, and the project's totals. Prices and context sizes come from the Gateway's `/v1/model/info` through `/ui/api/model-info`; a provider's own figure (OpenRouter's `usage.cost`, LiteLLM's `x-litellm-response-cost` header) wins when there is one.
- **Formatting and copying.** Replies render Markdown (headings, lists, tables, quotes, highlighted code). Every message has a copy button, and so does every code block. Messages can be edited and resent, and the last reply regenerated.
- **Export.** Download a chat as Markdown, copy it, or export every chat into one file.
- **Context.** Attach text files and images with the paperclip, by dropping them on the page, or by pasting. Under Options, each chat has a system prompt and notes the model sees with every message. The composer shows a rough token count for the request.
- **Strategy per chat.** Options → Model → **Strategy for this chat** picks where the chat's messages go: the default strategy, one of your named strategies from the Routing page, or **One model directly** to skip routing and send every message to the model you type. A project has the same choice in its settings, and its chats follow it unless they pick their own. Each reply says which strategy it used.
- **Tools.** A chat can use MCP servers and read a git repo on your computer. See [Chat tools: MCP servers and git repos](#chat-tools-mcp-servers-and-git-repos).
- **Voice.** The mic button (Ctrl+M) dictates into the message box, optionally sending when you stop talking. Replies can be read aloud on demand or automatically as they stream, with a choice of voice, speed, pitch and volume, and a Test button to hear a voice. Hands-free mode does both in a loop: turn it on with the headset button next to the mic (or under Options → Voice). It starts listening at once, sends when you pause, reads the reply aloud, then listens again; click it again to stop listening and reading. **Read clearly** (on by default) says symbols, shorthand and code names as words: `->` becomes "to", `e.g.` "for example", `10k` "10 thousand", `max_tokens` "max tokens", and a link becomes "a link to github.com". Dictation uses the browser's speech recognition (Chrome and Edge have one; they send the audio to their speech service), or the harness's own speech model when the browser has none. **Options → Voice → Dictation** picks one: **Auto** (the browser, else the server), **This browser**, or **Speech model**. Brave and some Chromium builds have no speech service and answer every attempt with `network`; with `OPENROUTER_API_KEY` in `.env` they fall back to it on their own. The microphone only works on `http://localhost` or https.

**Dictation through the harness.** With `OPENROUTER_API_KEY` set, `/ui/api/stt` sends the recording to OpenRouter's [speech-to-text models](https://openrouter.ai/collections/speech-to-text-models); it starts on the cheap Mistral Voxtral Mini Transcribe. `STT_URL` points it at another OpenAI-style server instead (Groq's free Whisper, OpenAI, a local Whisper, or a model in LiteLLM at `http://localhost:4000/v1`). The page records in short stretches, ends one when you pause, and adds each transcript to the message box.

#### Chat tools: MCP servers and git repos

The chat page can give the model tools. While it answers, the model can call them, see what they return, and keep going. Each call shows in the reply as a line you can click to see what was sent and what came back.

**Link a chat to a git repo.** Under Options → Tools, type the path of a folder inside a git repo on this computer (for example `C:\Users\you\code\my-project`) and press **Link**. Each chat has its own link. The model then gets read-only tools to list, read and search the repo's files (`git grep`), and to look at `git status`, the log, diffs and single commits. It can't change files, commit or push. Files that `.gitignore` covers are not listed, paths outside the repo and the `.git` folder are refused, and git must be installed.

**MCP servers, from the page.** Open **Tools** (a link on the Settings page, or Manage in the chat Options). **Add a server** takes a program (`npx`/`uvx` command, arguments, environment variables) or a web address (HTTP or SSE, with headers). **Test connection** connects without saving and lists the tools, or says what is wrong (for example that `uvx` isn't installed). **Popular servers** adds Memory, Fetch, Playwright and others in one click, or opens the form filled in for ones that need a folder or a key. Each server has an on/off switch and a tick per tool, so the model is offered only what you leave on. Saved values of environment variables and headers are never shown again (type a new one to replace it), and `${NAME}` references are shown as they are. Only admins, or this machine, can change servers, because a program server runs a command here. The page edits `mcp-servers.json`, so everything below still applies.

**MCP servers, from the file.** Copy `mcp-servers.example.json` to `mcp-servers.json` next to `server.js` and list your servers. The layout is the same as Claude Code's `.mcp.json`, so you can copy entries from there:

```json
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "${HOME}/Documents"] },
    "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/", "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" } }
  }
}
```

- A server with a `command` is started by the Interceptor and talks over stdio. One with a `url` is reached over HTTP (`"type": "http"`, the default for a `url`) or SSE (`"type": "sse"`).
- `${NAME}` and `${NAME:-default}` are filled in from your environment and `.env`, so keys can stay in `.env`. `${HOME}` is your home folder (also on Windows) and `${HARNESS_DIR}` is this repo's folder. A `${NAME}` with no value and no default stops that server with a message naming it. `mcp-servers.json` is gitignored anyway.
- The example file works as it is: `filesystem` (your `Documents` folder; change the path, and the folder must exist) and `jev-files` (needs the harness running) are on, `fetch` (needs [uv](https://docs.astral.sh/uv/)) and `github` (needs `GITHUB_TOKEN` in `.env`) are off until you remove `"disabled"`. Servers start in the repo folder, so `scripts/jev-files-mcp.js` needs no full path, and they get your whole environment (proxy and npm settings included). If a program such as `npx` or `uvx` isn't installed, the error says which one to install.
- `"disabled": true` keeps a server listed but not started. `"disabledTools": ["name", ...]` leaves those tools of a running server out of the chat (the Tools page's ticks).
- Slow or failing servers: each server connects on its own, so one that fails never holds up the others. Servers started with `npx`, `uvx` or `docker` get 120 s to connect (they download the package the first time) and one more try after a timeout; others get 30 s and no retry. Change this per server with `"timeoutMs"` (connect and list tools), `"retries"` (more tries after a timeout) and `"callTimeoutMs"` (one tool call, 120 s by default). A failed server's error says what to do: a timeout says to run its command once in a terminal to warm the cache, a 404 means the `url` is wrong or the service was removed (fix it or set `"disabled": true`), 401/403 means check its `headers`.
- You don't need an MCP entry for Artificial Analysis: model ratings come from `ARTIFICIAL_ANALYSIS_API_KEY` in `.env`.
- The Interceptor connects when it starts and prints each server's state. Options → Tools lists them with their tool counts and any start-up error. Untick a server to leave its tools out of your chats. Press **Reload** after editing the file.

Requests carry tools only when a chat is linked to a repo or an MCP server is ticked. Requests with tools go to a model that can call them (the Router's `strong_model_tools` or `weak_model_tools`, falling back to the strong model), not to the free chat model. Each round of tool calls is its own request through the Interceptor, so it is routed, logged and counted like any other. The reply's cost and token counts add up all of the rounds. A round that comes back with nothing at all — no text and no tool call, which is what a model that spends its whole answer thinking does — is tried once more, with twice the output room when the cap cut it off. If the second try is empty too, the reply says why (the output cap, the content filter, a tool call that arrived with no name, or that no tool list could be loaded) instead of leaving an empty bubble. **Max tool rounds** in the chat options sets how many rounds of tool calls a reply may use, and **0 means no limit** (the default): the reply goes on until the model stops calling tools or you press Stop, with the stall and no-reply timeouts still applying. Only rounds that really ran tools count towards it, not the empty-round retry. Tool results pass through Headroom like Claude Code's, so long results are trimmed to about 12,000 characters when Headroom is on.

Tools run only for requests from this computer (`/ui/api/tools/call` refuses others), and only the chat page uses them. Claude Code connects to its own MCP servers (`claude mcp add ...`), and its tool calls pass through the harness unchanged.

#### Usage

<http://localhost:3000/ui/usage.html> shows how many tokens went where, for today, the last 7 or 30 days, or all time:

- **Flow through the harness**: clients (Claude Code, the chat page, Aider, other API clients) into the Interceptor, how the model was picked (the Router, a pinned model, the client's choice, or the Router being down), then the Gateway and the service that answered (OpenRouter, Groq, Ollama, the local engine...). Line widths follow the tokens.
- **Sankey diagram**: client → model asked for → model that served it (after any Gateway fallbacks) → service, coloured by service.
- **Costs**: spend for the range, the 30-day pace it is on, the cost per request and per million tokens, and how many requests went to free or local models. Prices come from the Gateway's price list (`/v1/model/info`) for the model that answered; models with no listed price show `?` and are left out of the totals. Cached input is counted at the full input price, so the figures can run a little high for Anthropic models.
- **Over time**: a bar per day, split by the service that answered.
- **Bars and a table** of input, cached input and output tokens, requests and cost by model and by service. A switch sizes every chart by all tokens, input, output, request counts or cost.

The counts are the ones each reply reports (`usage` in OpenAI replies, `input_tokens`/`output_tokens` in Anthropic ones, streamed or not), read one way everywhere by `ui/tokens.js`, so the chat page, this page and the dashboard always agree. A stream reports usage in pieces, so the largest of each count is kept. Replies without any, such as OpenAI streams that don't ask for `stream_options.include_usage`, are estimated from the request that was sent and the text that came back (about 4 characters a token) and marked ~. The chat page counts a reply as it arrives, not only when it ends. The service for each model comes from its `litellm_params` in `config.yaml`. Totals are kept per day in `harness-usage.json` (gitignored) so they survive a restart; **Clear totals** on the page empties it. The page updates live as requests finish, and the dashboard's routing log shows the same in/out counts per request.

#### Routing editor

<http://localhost:3000/ui/routing.html> draws the strategy as connected boxes: the Interceptor (pin, Router down), the Router (classifier, threshold, and its Strong / Weak / Weak with tools / Weak over N tokens outputs), and every model the Gateway serves. Each model box lists the provider models that answer for it ("Served by") and its fallback chain. A **How to use this page** guide sits at the top, and every part of the page shows a hint on hover.

- **Routes:** drag from a dot on the right of a box to a model to connect it; click a line and press **Remove connection** (or Delete) to unset it.
- **Fallbacks:** drag a model's "If it fails" dot to another model; reorder with the arrows in its box. Hover a model to see its fallback lines in full.
- **Compression:** the Compression box turns the Interceptor's transforms on and off for the strategy shown: short replies (caveman), shrinking long tool results (Headroom) and skipping repeated tool results (context anchor).
- **Tools:** the Tools box lists the MCP servers from `mcp-servers.json` with their status; untick one to stop Bright Chat offering it to the model in chats on that strategy. **Reload servers** reconnects them.
- **Named strategies:** the **Routing** picker above the boxes switches between the default strategy and named ones. **New strategy** copies the strategy shown under a new name; its route lines, threshold, Router-down models, compression and tools are its own, while the classifier and model boxes are shared by every strategy. Fallback lines start as the Gateway's (from `config.yaml`); change one while a named strategy is shown and that strategy keeps its own chains, sent to the Gateway with each of its requests (they replace the Gateway's chains for that request, so a model without a line has no fallback). **Use Gateway fallbacks** drops them. The default strategy's lines are the Gateway's and need a Gateway restart; a named strategy's don't. Chats and projects pick one in Bright Chat; any other client sends the header `x-harness-profile: <id>` (Claude Code: `ANTHROPIC_CUSTOM_HEADERS="x-harness-profile: cheap-and-quick"`). Named strategies are saved in `routing-profiles.json` (gitignored); a request with an unknown id uses the default.
- **Auto strategy:** each named strategy has a **When Auto picks this strategy** box: a one-line description and optional rules (words in the message, tools or not, client such as Claude Code, request size). Choose **Auto** in a chat's strategy list, or send `x-harness-strategy: auto` (the older name `x-harness-profile` works too). Jev (the Router's classifier) rates each description right away and the best fit at or above `autoAskAt` (Settings, 0.5) wins; if none fits, the first strategy whose rules hold is used; otherwise the default. `autoFirst` on the Settings page can put the rules first, and `autoJev` turns Jev off. Agents use it the same way: set the header on their requests (Claude Code: `ANTHROPIC_CUSTOM_HEADERS="x-harness-strategy: auto"`) or name one strategy per agent. The routing log and the `x-harness-auto` response header say which strategy was chosen and why.
- **Tiers:** Strong and Weak are two tiers. **+ Add tier** on the Router adds more, each with a name, a score it starts from and its own model (plus an optional model for requests with tools). A request goes to the highest tier its score reaches: a tier from 0.85 above a 0.6 threshold catches the hardest requests (a frontier model), a tier from 0.3 catches middling ones between Weak and Strong. Up to 8 extra tiers per strategy; the default strategy keeps them in `harness-settings.json`, named strategies in `routing-profiles.json`. **Has an image** on the Request box sends messages carrying a picture to a model that reads images, without asking the Router. Requests with tools (Claude Code) keep their normal route, so an images model that can't call tools never ends an agent's loop.
- **Model numbers:** each model box shows quality (0 to 100), coding score, price per million tokens, speed and strengths (coding, reasoning, tools, images, long context, fast, cheap, local, free, or any you add). Prices come from the Gateway and OpenRouter. Quality, coding and speed come from [Artificial Analysis](https://artificialanalysis.ai/)'s free benchmark API when `ARTIFICIAL_ANALYSIS_API_KEY` is in `.env` (matched by provider model id; pick the right entry under **Edit** if the match is wrong), or from what you type under **Edit** (saved in `model-stats.json`, gitignored). The Router box warns when a higher tier's model scores lower than the tier below it.
- **Models:** **Add model** creates a new name in the Gateway with the provider model behind it (OpenRouter, Groq, Ollama, the local engine, another OpenAI-compatible server, or any LiteLLM id). With OpenRouter picked, the dialog opens wide and lists OpenRouter's whole live model catalog as a table of context size, input and output price and what each model can do (tools, reasoning, images). Search it, filter by **Free**, **Tools**, **Reasoning**, **Images** or maker, sort by newest, cheapest, biggest context or name, and click a model to fill in its id (and a name for a new box) and see its details: description, longest reply, cached-input, image and reasoning prices, what it reads and writes, tokenizer, release date and accepted parameters, with a link to its OpenRouter page. **+ Add provider model** adds another one to an existing model, and the Gateway shares requests between them. Press and hold × in a model's title to remove it with its provider models and fallback lines; × next to a provider model removes just that one. **Clear unconnected models** removes, after asking, every model box no route reaches in any strategy, directly or through fallbacks (such as the ready-to-wire `or-*` models, or a model whose only line is a fallback from another unreachable one), with their `model_list` entries and fallback lines. Those boxes are drawn dashed with "No route reaches it". It is off while the Router is down, since its outputs can't be read. If Save finds something to fix (an output left unconnected, a missing token limit), it lists it in a box at the bottom right and outlines the boxes involved in red with the reason inside; a problem in another strategy has a **Show** button. **Tidy layout** puts the boxes in columns that follow the lines of the strategy shown (routes, then fallbacks), ordered so lines cross as little as possible.
- **Live:** with **Show live requests** on, the path of each request lights up as it is routed.

**Save** writes each change where its owner reads it: the Router's choices to `routellm-config.yaml` (as "Apply and save" on the Settings page does), the Interceptor's to `harness-settings.json`, named strategies to `routing-profiles.json`, and models and fallback chains to `config.yaml`. In `config.yaml` it only removes or appends whole `model_list` entries and rewrites the fallback lines that changed, so comments and other settings stay; a new entry gets `model`, `api_base` and `api_key` (as `os.environ/NAME`, never a literal key), and options like `max_parallel_requests` can be added by hand afterwards. If the file changed since the page loaded, Save refuses and asks you to reload. The Router and Interceptor use their changes on the next request; **restart the Gateway** (LiteLLM) for model and fallback changes. Box positions are kept in the browser; **Tidy layout** lays them out again.

#### Read-aloud voices

Under Options → Voice, **Read aloud with** chooses between a speech model and the browser's own voices.

**Speech model (the default).** With `OPENROUTER_API_KEY` in `.env`, the harness offers every [OpenRouter speech model](https://openrouter.ai/collections/text-to-speech-models) in the **Speech model** menu, with each model's voices in the **Voice** menu. It starts on the free Fish Audio model; paid ones include Kokoro ($0.62 per million characters), Gemini Flash TTS, Microsoft MAI Voice and ElevenLabs. Your choice is saved in the browser. The page reads in pieces: a short first one so speech starts quickly, then longer ones, and it fetches only the piece after the one playing, so stopping early saves the rest of the speech tokens.

**Browser voices.** Free and offline, but quality depends on the browser: Edge on Windows has the best (the "Online (Natural)" voices, marked ★ and picked by default), Chrome has "Google" voices, and the built-in Windows voices sound robotic.

Optional `.env` settings:

| Setting | What it does |
|---|---|
| `TTS_URL` | Use another OpenAI-style speech server instead of OpenRouter: [Kokoro](https://github.com/remsky/Kokoro-FastAPI) locally (`docker run -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest`, then `http://localhost:8880/v1`), OpenAI (`https://api.openai.com/v1` with `TTS_API_KEY`), or a TTS model in LiteLLM (`http://localhost:4000/v1`). |
| `TTS_MODEL`, `TTS_VOICE` | The default model and voice before you pick in the page. |
| `TTS_API_KEY` | Key for `TTS_URL`. Not needed for OpenRouter or the Gateway. |
| `TTS_VOICES` | Comma-separated voices for the default model, when the server doesn't list them. |
| `TTS_INSTRUCTIONS` | Tone and pacing for models that take it (OpenAI, Gemini, Fish Audio), e.g. `Calm, friendly, a little brisk`. |
| `STT_URL` | Use another OpenAI-style server for dictation instead of OpenRouter: Groq's Whisper (`https://api.groq.com/openai/v1`), OpenAI (`https://api.openai.com/v1` with `STT_API_KEY`), a local Whisper server, or a model in LiteLLM (`http://localhost:4000/v1`). |
| `STT_MODEL`, `STT_LANGUAGE` | The transcription model and its default language. |
| `STT_API_KEY` | Key for `STT_URL`. Not needed for OpenRouter or the Gateway. |

Any client can skip the Router for one request the same way: send the model name in an `x-harness-model` header, or use a named strategy with `x-harness-profile`. Every routed response carries `x-harness-model` and `x-harness-route` headers saying where it went, `x-harness-tier` with the tier it landed in, plus `x-harness-profile` when a named strategy was used.

**Effort.** The `x-harness-effort` header moves a request's score before tiers are matched: `low` and `high` by 0.2, `min` sends it to Weak and `max` to the top tier (a number from -1 to 1 works too). In Bright Chat it is the **Effort** button next to Send, saved per chat. A new chat also has an **Answer with** menu on its start screen: pick a strategy or one Gateway model directly (with its quality and price when known); outside projects the next new chat starts with the same pick. Claude Code: `ANTHROPIC_CUSTOM_HEADERS="x-harness-effort: low"`.

History is kept in memory (the last 200 requests) and starts fresh when the Interceptor restarts. Override the probed addresses with `LOCAL_ENGINE_URL`, `OLLAMA_URL` and `LAYA_URL` in `.env`. The pages have no login. The Interceptor listens on every network interface, so other machines that can reach port 3000 can view them and chat, but settings only change from requests made on this machine.

---

## Utility scripts

### Start everything

`npm run all` (`scripts/start-all.js`) runs the Gateway, Router and Interceptor together from `.venv` (`.venv\Scripts` on Windows, `.venv/bin` elsewhere; falls back to `PATH`). Ollama starts only with `npm run all:ollama`, `npm run all -- --ollama` or `START_OLLAMA=1` in `.env`, and not when something already answers at `OLLAMA_URL`. `--no-ollama` overrides `START_OLLAMA`. `npm run full` runs `validate` and the tests first, then starts everything.

### Compress standing context files

Trims `CLAUDE.md` and `.qwen/settings.json` before a session to reduce foundational token overhead. Originals are backed up as `.bak`.

```bash
npm run compress
# target specific files:
node caveman-compress.js path/to/CLAUDE.md
```

### Validate config directories

Scans `.vscode`, `.qwen`, and `.claude` for non-breaking spaces, BOM characters, smart quotes, and en/em dashes that silently break VS Code's JSON parser.

```bash
npm run validate          # report only
npm run validate:fix      # auto-correct in place
```

---

## How routing decisions are made

The interceptor scores the text typed in the latest user turn for complexity signals before forwarding to RouteLLM. The system prompt and tool output are never scored, and turns that only carry tool results keep the strategy of the request that started them. Requests that define tools (every Claude Code request) go to `strong_model_tools` when hard (unset: the strong model) or `weak_model_tools` when easy (`fallback-openrouter-tools`, the free NVIDIA Nemotron model), because a model without tool support answers them with text instead of tool calls. On the Routing page these are the Router's **Strong, with tools** and **Weak, with tools** outputs:

| Signal type | Examples | Threshold | Effect |
|-------------|----------|-----------|--------|
| Complex | architect, refactor, debug, security, algorithm | 0.20 | Favours strong model |
| Balanced | (mixed or no signal) | 0.50 | Default |
| Simple | test, format, lint, rename, comment | 0.80 | Favours free weak model |

The threshold is encoded as `router-bert-<threshold>` — the strict three-part format required to prevent RouteLLM `ValueError` parser crashes.

---

## Tests

```bash
npm test                                   # Interceptor (Node)
pip install -r requirements-test.txt
python -m pytest test/                     # Router: contract tests and every backend end to end
```

`test/test_router_backends.py` starts the real Router for each backend and calls `/route` over HTTP. It runs RouteLLM on a tiny BERT checkpoint built on the spot, the real `laya` Router and a real `laya-serve` (the Jev protocol, with auth), a local stand-in for a reasoning model, and a custom scorer; only model weights and paid endpoints are faked. To run against the real thing, set any of:

| Variable | Runs |
|---|---|
| `ROUTER_LIVE_ROUTELLM=1` | the `routellm/bert_gpt4_augmented` checkpoint (downloads from Hugging Face) |
| `ROUTER_LIVE_LAYA=1` | real Laya weights (downloads from Hugging Face) |
| `ROUTER_LIVE_JEV_URL` (+ `ROUTER_LIVE_JEV_KEY`, `ROUTER_LIVE_JEV_MODEL`) | a real Jev or `laya-serve` |
| `ROUTER_LIVE_LLM_URL` + `ROUTER_LIVE_LLM_MODEL` (+ `ROUTER_LIVE_LLM_KEY`) | a real OpenAI-compatible reasoning model |

---

## License

MIT
