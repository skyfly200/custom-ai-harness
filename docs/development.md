# Utility scripts and tests

Start-everything, config validation, context compression and the test suite. Back to the [README](../README.md).

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


## How routing decisions are made

The interceptor scores the text typed in the latest user turn for complexity signals before forwarding to RouteLLM. The system prompt and tool output are never scored, and turns that only carry tool results keep the strategy of the request that started them. Requests that define tools (every Claude Code request) go to `strong_model_tools` when hard (unset: the strong model) or `weak_model_tools` when easy (`fallback-openrouter-tools`, the free NVIDIA Nemotron model), because a model without tool support answers them with text instead of tool calls. On the Routing page these are the Router's **Strong, with tools** and **Weak, with tools** outputs:

| Signal type | Examples | Threshold | Effect |
|-------------|----------|-----------|--------|
| Complex | architect, refactor, debug, security, algorithm | 0.20 | Favours strong model |
| Balanced | (mixed or no signal) | 0.50 | Default |
| Simple | test, format, lint, rename, comment | 0.80 | Favours free weak model |

The threshold is encoded as `router-bert-<threshold>` — the strict three-part format required to prevent RouteLLM `ValueError` parser crashes.


## Dialogs in the web UI

Never use the browser's `alert()`, `confirm()` or `prompt()` in `ui/`. `ui/dialogs.js` (loaded first on every page) gives `ui.toast(text, { kind: 'error' })`, `await ui.confirm(text, { ok, danger })` (true/false) and `await ui.prompt(text, { value, type, ok })` (string, or null when cancelled). They are keyboard accessible (Enter, Esc, Tab stays inside) and follow light/dark and phone width. `test/dialogs.test.js` fails when a native call appears. A new page must load `dialogs.js` before its other scripts.

## Tests

```bash
npm test                                   # Interceptor (Node): about 430 tests, ~25 s
npm run test:fast                          # everything except the 3 slowest files (mcp, gateway, spritesSandbox)
npm run test:slow                          # just those 3
npm run test:for                           # only the Node tests that mention files you changed
npm run test:for -- utils/guard.js         # ...or files you name
node --test test/guard.test.js             # one file
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

### Which tests cover what

- `test/dialogs.test.js`: no native alert/confirm/prompt in `ui/`, dialogs.js loaded first on every page.

| Area | Test files |
|---|---|
| Login, passwords, API keys | `access`, `login`, `oauth`, `runKeys` |
| Routing, tiers, profiles, Auto | `interceptor`, `profiles`, `tiers`, `autoStrategy`, `autoroute`, `escalate`, `jevQuestions` |
| Command guard, Jev file tools | `guard`, `gatewayGuard`, `jevFiles` |
| Gateway config and model info | `gateway`, `gatewayConfig`, `modelInfo`, `modelInfoApi`, `modelStats`, `openrouterCatalog` |
| Runner, agents, swarm, workflows | `runner`, `runnerAgent`, `swarm`, `workflows`, `agents`, `apps`, `preview`, `terminal`, `e2bSandbox`, `spritesSandbox` |
| MCP tools | `mcp`, `mcpAdmin`, `toolsApi` |
| Chat page logic | `markdown`, `cachetimer`, `chatShell.*`, `chatSync`, `chatCommands` |
| Connect OpenRouter (OAuth PKCE) | `openrouterOAuth` |
| Connect GitHub, chat GitHub tools | `githubOAuth` (token renewal, in-process Postgres), `githubApi`, `guests` (routes) |
| Guests, credit, own keys, proxy tickets | `guests` (in-process Postgres) |
| Per-user tools, routings, settings | `userTools` (secrets, address checks, member MCP, routings; in-process Postgres) |
| Router (Python) | `test_router.py`, `test_router_backends.py`, `test_gateway_start.py` |

Shared fake servers live in `test/helpers/stubs.js` (`fakeGateway(onRequest)` answers like an OpenAI-style Gateway); use them instead of writing another `http.createServer` stub. When a test file isn't listed here, `npm run test:for -- path/to/file.js` finds the tests that mention it.
