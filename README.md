# Custom AI Coding Harness

A high-performance, cost-optimized proxy and routing harness designed to sit between your coding agent (such as Claude Code or Cursor) and local/cloud LLM endpoints.

Four phases of the [technical roadmap](ROADMAP.md) are fully implemented:

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Architecture Stabilization & Core Routing | ✅ |
| 2 | Intelligent Complexity Routing (RouteLLM & BERT) | ✅ |
| 3 | Zero-Cost Token & Context Compression | ✅ |
| 4 | Local Model Resilience & Anti-Looping | ✅ |

---

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
        ├─(complex)─► Port 4000 — LiteLLM proxy → Tier 1 local engine (port 8000)
        │                                        → Groq GPT-OSS 20B fallback
        │                                        → OpenRouter free-tier catch-all
        │
        └─(simple)──► Port 4000 — LiteLLM proxy → Groq GPT-OSS 20B (free tier)
                                                 → OpenRouter free-tier catch-all
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
Tier 1 local engine → fallback-groq (GPT-OSS 20B) → fallback-groq-20b → fallback-openrouter
```

Deprecated Llama 3/3.1 variants are intentionally absent; GPT-OSS 20B is the active free-tier workhorse.

Each deployment sets `max_parallel_requests` (CLI wrapper 1, Groq 3, OpenRouter 5), so bursts queue in the Gateway instead of tripping provider rate limits. The cap is per entry, so aliases for one backend add up.

### `routellm-config.yaml`

Configures `router.py`: the local RouteLLM `bert` checkpoint (no external embedding API key needed) and the Gateway model names it picks between. The Router only classifies; the Interceptor then sends the request to the Gateway on port 4000 itself.

RouteLLM's bundled `openai_server` is not used: it rejects tool schemas, can't carry the Anthropic format, and needs an `OPENAI_API_KEY` even for BERT.

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

### 4. Node.js interceptor (port 3000)

```powershell
npm start
```

Point an OpenAI-compatible assistant (Cursor, Aider, Continue, Cline) at `http://localhost:3000/v1`.

### Using Claude Code through the harness

```powershell
$env:ANTHROPIC_BASE_URL = "http://localhost:3000"
$env:ANTHROPIC_AUTH_TOKEN = "local-harness"   # dummy; keeps your real Anthropic credentials off the local stack
claude
```

The Interceptor routes each request and the Gateway translates the Anthropic Messages format for whichever model serves it, including tool use and streaming. The Interceptor log shows each routing decision.

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

The interceptor scores the text typed in the latest user turn for complexity signals before forwarding to RouteLLM. The system prompt and tool output are never scored, and turns that only carry tool results keep the routing of the request that started them:

| Signal type | Examples | Threshold | Effect |
|-------------|----------|-----------|--------|
| Complex | architect, refactor, debug, security, algorithm | 0.20 | Favours strong model |
| Balanced | (mixed or no signal) | 0.50 | Default |
| Simple | test, format, lint, rename, comment | 0.80 | Favours free weak model |

The threshold is encoded as `router-bert-<threshold>` — the strict three-part format required to prevent RouteLLM `ValueError` parser crashes.

---

## Tests

```bash
npm test
```

---

## License

MIT
