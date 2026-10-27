# Architecture and files

How the parts fit together and what each file is for. Back to the [README](../README.md).

## Technical reference

Everything below is the detail behind the quick start: how each part works, every setting, and how to run the tests.

The [technical roadmap](../ROADMAP.md) has four phases, all implemented:

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


## Files

| File | Purpose |
|------|---------|
| `server.js` | Node.js interceptor — Caveman injection, Headroom compression, RouteLLM model routing |
| `config.yaml` | LiteLLM proxy — model list, fallback chain, port 4000 |
| `router.py` | Router — local BERT classifier service; picks the strong or weak Gateway model |
| `routellm-config.yaml` | Router — BERT checkpoint and strong/weak Gateway model names |
| `.env.example` | Environment variable template — copy to `.env` and fill in keys |
| `mcp-servers.example.json` | MCP servers for the chat page — copy to `mcp-servers.json` (see [Chat tools](chat.md#chat-tools-mcp-servers-and-git-repos)) |
| `launch-local.sh` | Hardened launcher for llama.cpp / vLLM local engines |
| `launch-laya.sh` | CPU launcher for the self-hosted Laya server the Router classifies with |
| `caveman-compress.js` | Standing context trimmer for `CLAUDE.md`, `.qwen/settings.json` |
| `validate-config.js` | UTF-8 / non-breaking space validator for config directories |
| `docker-compose.yml`, `Dockerfile`, `docker/` | The three parts as containers, for a server, plus the task runner as a fourth (`COMPOSE_PROFILES=runs`) (see [Run it on a server](server-docker.md#run-it-on-a-server-docker)) |
| `utils/access.js` | The optional `HARNESS_PASSWORD` login |
| `utils/login.js`, `utils/users.js`, `ui/users.html`, `scripts/hash-password.js` | Named logins with admins (see [Named logins](logins.md#named-logins-with-admins-harness_require_login)) |
| `guard-rules.json`, `utils/guard.js`, `.claude/hooks/guard.js` | The command guard (see [Command guard](claude-code.md#command-guard-jev-checks-commands-before-they-run)) |
| `scripts/jev-files-mcp.js`, `utils/jevFiles.js`, `utils/jevAsk.js` | The `ask_jev_file` tools (see [Ask Jev about a file](claude-code.md#ask-jev-about-a-file-ask_jev_file-tools)) |
| `workflows/`, `utils/workflows.js` | Recipes for the task runner and Jev's pick between them |
| `runner/`, `ui/agents.html` | The task runner: sandbox, tools, agent loop, run manager and API (see [Task runner](task-runner.md#task-runner-agents-that-do-a-whole-task)) |
| `ui/manifest.webmanifest`, `ui/sw.js`, `ui/icon*.svg`, `ui/icon-*.png` | The installable app: manifest, offline copy of the pages, icons (re-render the PNGs from the SVGs if the logo changes) |
