# Custom AI Coding Harness

## What this is, in plain words

The harness is a middleman between your AI coding assistant (Claude Code, Cursor and similar tools) and the AI models that answer it. Your assistant talks to the harness as if it were the AI service. For every request, the harness decides how hard the task is, sends easy work to free models and hard work to a stronger model, and trims the request so it uses fewer tokens. If one model is down or rate-limited, it automatically tries the next one.

What you get:

- **Lower cost.** Most requests go to free models, and requests are compressed before they are sent.
- **Fewer failures.** When a model refuses, errors or hits its limit, another one takes over.
- **A dashboard.** A web page shows what each request did, which model answered and why, and lets you change settings without editing files.

### The three parts you run

| Part | What it does | Address |
|------|--------------|---------|
| **Interceptor** | The front door. Your coding assistant connects here. It also serves the dashboard and chat page. | http://localhost:3000 |
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

Open three PowerShell windows, `cd` into the `custom-ai-harness` folder in each, and run one command per window. Leave all three open while you work.

| Window | Starts | Command |
|--------|--------|---------|
| 1 | Gateway | `.\.venv\Scripts\Activate.ps1; $env:PYTHONUTF8 = 1; litellm --config config.yaml` |
| 2 | Router | `.\.venv\Scripts\Activate.ps1; python router.py` |
| 3 | Interceptor | `npm start` |

Then open the dashboard at <http://localhost:3000/ui>. When the Router and Gateway show as up, the harness is ready. The local engine, Ollama and Laya are optional and normally show as "not running". To stop, press Ctrl+C in each window.

### Connect Claude Code

In a fourth PowerShell window:

```powershell
$env:ANTHROPIC_BASE_URL = "http://localhost:3000"
$env:ANTHROPIC_AUTH_TOKEN = "local-harness"
$env:CLAUDE_CODE_AUTO_MODE_SERVER = "0"
claude
```

These settings only last for that window. Other tools such as Cursor, Aider, Continue or Cline connect to `http://localhost:3000/v1` as an "OpenAI-compatible" endpoint.

### If something goes wrong

- **The dashboard shows the Router or Gateway as down.** Check that window for an error message. Most often a key in `.env` is missing or mistyped.
- **`litellm` crashes on start with a text-encoding error.** Make sure you ran `$env:PYTHONUTF8 = 1` in that window first.
- **`litellm` or `python router.py` says a command or module is not found.** Run `.\.venv\Scripts\Activate.ps1` in that window first; each new window needs it.
- **Requests are slow or fail with "rate limit".** The free tiers have limits per minute and per day. The harness switches to backups on its own; the dashboard shows which ones it tried.

---

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
| `launch-local.sh` | Hardened launcher for llama.cpp / vLLM local engines |
| `launch-laya.sh` | CPU launcher for the self-hosted Laya server the Router classifies with |
| `caveman-compress.js` | Standing context trimmer for `CLAUDE.md`, `.qwen/settings.json` |
| `validate-config.js` | UTF-8 / non-breaking space validator for config directories |

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

`LITELLM_MASTER_KEY` is optional. Set it to require a key on the Gateway and to log in to LiteLLM's admin UI at http://localhost:4000/ui (username `admin`, the key as the password). LiteLLM reads it from `.env` too, as long as LiteLLM is installed in this repo's `.venv` as shown above (LiteLLM looks for `.env` in the folders above its own install, not the folder you start it from). If LiteLLM is installed somewhere else, set the variable in the shell before starting it. The harness then sends the master key on every call it forwards to LiteLLM, so clients such as Claude Code keep working with whatever key they already use. Generate one with:

```bash
python -c "import secrets; print('sk-' + secrets.token_urlsafe(32))"
```

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
Tier 1 local engine → fallback-openrouter → fallback-groq (GPT-OSS 120B)
```

Deprecated Llama 3/3.1 variants are intentionally absent. Groq serves GPT-OSS 120B: its free tier gives it the same limits as the 20B (8K tokens/min, 1K requests/day), so the bigger model costs nothing extra.

Each deployment sets `max_parallel_requests` (CLI wrapper 1, Groq 3, OpenRouter 5), so bursts queue in the Gateway instead of tripping provider rate limits. The cap is per entry, so the two CLI wrapper aliases add up to 2.

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

```powershell
$env:ANTHROPIC_BASE_URL = "http://localhost:3000"
$env:ANTHROPIC_AUTH_TOKEN = "local-harness"   # dummy; keeps your real Anthropic credentials off the local stack
$env:CLAUDE_CODE_AUTO_MODE_SERVER = "0"       # auto mode: skip server-side checks the harness can't carry
claude
```

The Interceptor routes each request and the Gateway translates the Anthropic Messages format for whichever model serves it, including tool use and streaming. The Interceptor log shows each routing decision.

**Auto mode.** Claude Code's auto mode asks Anthropic's server to run its safety checks inside each request, but the harness rewrites requests and sends them to non-Anthropic models, so those checks never reach the session. `CLAUDE_CODE_AUTO_MODE_SERVER=0` tells Claude Code to use its own classifier requests from the start instead of stopping at the first checked action with an "isn't eligible" notice. Those classifier requests also go through the Interceptor and are routed like any other request, so the Gateway model that serves them judges whether an action is safe. See [Auto mode classifier request charges](https://code.claude.com/docs/en/auto-mode-classifier-billing).

### Control UI

With the Interceptor running, open <http://localhost:3000/ui>. The dashboard refreshes every 3 seconds and shows:

- **Components**: whether the Router, Gateway, local engine (port 8000), Ollama (11434) and a local Laya (8001) answer, and which classifier the Router is using. The last three are optional and show as "not running" rather than down.
- **Counters** since the Interceptor started: requests, times the Router couldn't be reached, Gateway fallbacks and errors.
- **Recent routing decisions**: the model each request went to and why (win rate against threshold, tool requests, a pinned model, or the Router being down), the Gateway's status and time to first byte, how many fallbacks LiteLLM tried and which model group answered (from LiteLLM's `x-litellm-attempted-fallbacks` and `x-litellm-model-group` headers, when your LiteLLM version sends them), and the start of the typed request.
- **Interceptor settings**: pin every request to one model (skipping the Router), replace the keyword threshold with a fixed one, the output-token cap, the Router timeout, the models used when the Router is down, and switches for the caveman prompt, Headroom and the context anchor. They apply on the next request and are saved to `harness-settings.json` (gitignored); delete it or press "Reset to defaults" to go back.
- **Router settings**: the strong, weak, tool and overflow models, the weak model's size limit, the classifier backend and its settings (base URL, model, API key variable name, timeout, and so on). **Apply** lasts until the Router restarts; **Apply and save to file** also writes them to `routellm-config.yaml`, editing only those lines and keeping your comments (a cleared setting is commented out); **Reload from file** picks up edits you made by hand. A change that fails to build the classifier leaves the running one in place.

Model fields suggest the names from the Gateway's `/v1/models` (or `config.yaml` when the Gateway is down). The Gateway's own fallback chain still lives in `config.yaml`.

#### Chat

<http://localhost:3000/ui/chat.html> is a chat page that sends through the Interceptor like any other client, so the Router picks the model unless you name one. What it does:

- **Live progress.** Each reply shows its steps as they happen: the Router choosing, the model it picked and why, the transforms applied, the Gateway's answer (with fallbacks and the model that actually served it), time to first token and tokens per second. The **Activity** panel shows every request through the harness live, from this page and from other clients such as Claude Code, plus the health of each part. Both come from `/ui/api/live`, a Server-Sent Events feed of the routing log.
- **Chats.** Every chat is saved in the browser and listed on the left with search. Alt+↑/↓ moves between chats, Ctrl+Shift+O starts a new one, Ctrl+K searches.
- **Formatting and copying.** Replies render Markdown (headings, lists, tables, quotes, highlighted code). Every message has a copy button, and so does every code block. Messages can be edited and resent, and the last reply regenerated.
- **Export.** Download a chat as Markdown, copy it, or export every chat into one file.
- **Context.** Attach text files and images with the paperclip, by dropping them on the page, or by pasting. Under Options, each chat has a system prompt and notes the model sees with every message. The composer shows a rough token count for the request.
- **Voice.** The mic button (Ctrl+M) dictates into the message box, optionally sending when you stop talking. Replies can be read aloud on demand or automatically as they stream, with a choice of voice and speed. Hands-free mode does both in a loop. Voice uses the browser's own speech features: dictation needs Chrome or Edge, and they send the audio to their speech service. The microphone only works on `http://localhost` or https, not from another machine over plain http.

Any client can skip the Router for one request the same way: send the model name in an `x-harness-model` header. Every routed response carries `x-harness-model` and `x-harness-route` headers saying where it went.

History is kept in memory (the last 200 requests) and starts fresh when the Interceptor restarts. Override the probed addresses with `LOCAL_ENGINE_URL`, `OLLAMA_URL` and `LAYA_URL` in `.env`. The pages have no login. The Interceptor listens on every network interface, so other machines that can reach port 3000 can view them and chat, but settings only change from requests made on this machine.

---

## Utility scripts

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

The interceptor scores the text typed in the latest user turn for complexity signals before forwarding to RouteLLM. The system prompt and tool output are never scored, and turns that only carry tool results keep the routing of the request that started them. Requests that define tools (every Claude Code request) go to the strong model or, when weak, to `weak_model_tools` (`fallback-openrouter-tools`), because the wildcard free tier may answer them with text instead of tool calls:

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
