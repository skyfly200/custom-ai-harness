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
        │  • Injects Caveman compression prompt
        │  • Headroom: compresses tool outputs & file payloads
        │  • Derives complexity threshold from message content
        │  • Rewrites model name → router-bert-<threshold>
        │
        ▼  Port 6060 — RouteLLM (BERT classifier, no external embedding API)
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
| `routellm-config.yaml` | RouteLLM — BERT router, strong/weak model targets |
| `launch-local.sh` | Hardened launcher for llama.cpp / vLLM local engines |
| `caveman-compress.js` | Standing context trimmer for `CLAUDE.md`, `.qwen/settings.json` |
| `validate-config.js` | UTF-8 / non-breaking space validator for config directories |

---

## Prerequisites

- **Node.js** 18+
- **Python** 3.10+ with a virtual environment
- **llama.cpp** or **vLLM** (optional — only needed for local Tier 1 engine)

---

## Installation

```bash
git clone https://github.com/skyfly200/custom-ai-harness.git
cd custom-ai-harness

# Node dependencies
npm install

# Python dependencies
python -m venv .venv
source .venv/bin/activate          # Windows: .\.venv\Scripts\activate
pip install "litellm[proxy]" routellm
```

---

## Configuration

### Environment variables

```bash
export GROQ_API_KEY=your_groq_key
export OPENROUTER_API_KEY=your_openrouter_key
# Optional — only needed if Tier 1 calls a remote Anthropic endpoint
export ANTHROPIC_API_KEY=your_anthropic_key
```

### `config.yaml`

Defines the LiteLLM model list and fallback chain. The fallback order for every strong-model request is:

```
Tier 1 local engine → fallback-groq (GPT-OSS 20B) → fallback-groq-20b → fallback-openrouter
```

Deprecated Llama 3/3.1 variants are intentionally absent; GPT-OSS 20B is the active free-tier workhorse.

### `routellm-config.yaml`

Uses the local `bert` router — no external embedding API key (`text-embedding-3-small`) required. Strong and weak models both resolve through the LiteLLM proxy on port 4000.

---

## Running the stack

Open three terminal sessions (or use a process manager like `tmux`/`pm2`):

**1. Local engine** (skip if routing entirely to cloud fallbacks)
```bash
# Qwen Coder
./launch-local.sh qwen models/qwen2.5-coder-7b-instruct-q5_k_m.gguf

# Gemma 4
./launch-local.sh gemma models/gemma-4-9b-it-q5_k_m.gguf
```

**2. LiteLLM proxy** (port 4000)
```bash
source .venv/bin/activate
litellm --config config.yaml
```

**3. RouteLLM classifier** (port 6060)
```bash
source .venv/bin/activate
python -m routellm.openai_server --config routellm-config.yaml --port 6060
```

**4. Node.js interceptor** (port 3000)
```bash
npm start
```

Point your coding assistant to `http://localhost:3000/v1`.

---

## Utility scripts

### Compress standing context files
Trims `CLAUDE.md` and `.qwen/settings.json` before a session to reduce foundational token overhead. Originals are backed up as `.bak`.

```bash
npm run compress
# or target specific files:
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

The interceptor analyses each request's message content for complexity signals before forwarding to RouteLLM:

| Signal type | Examples | Threshold | Effect |
|-------------|----------|-----------|--------|
| Complex | architect, refactor, debug, security, algorithm | 0.20 | Favours strong model |
| Balanced | (mixed or no signal) | 0.50 | Default |
| Simple | test, format, lint, rename, comment | 0.80 | Favours free weak model |

The threshold is encoded as `router-bert-<threshold>` — the strict three-part format required to prevent RouteLLM `ValueError` parser crashes.

---

## License

MIT
