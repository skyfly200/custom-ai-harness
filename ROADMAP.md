# Custom AI Harness: Technical Roadmap

This roadmap outlines the strategic upgrades for the `custom-ai-harness` repository. It builds upon our multi-tier local proxy architecture to optimize token consumption, integrate local compression and routing intelligence, and harden execution against local model loops.

The work splits into two parts (see [ADR 0002](docs/adr/0002-orchestrator-is-an-optional-add-on.md)):

* **Core — the Model Layer (Phases 1–4):** Interceptor → Router → Gateway. Stateless, runs on its own, and is useful to any agent pointed at port 3000.
* **Add-on — the Orchestrator:** a separate, higher-level layer for planning, dispatch, and audit. It consumes the Model Layer like any other client; the core never depends on it. Orchestrator work starts after the core phases are finished.

---

# Core: Model Layer

## Phase 1: Architecture Stabilization & Core Routing
* ✅ **Unified Service Interceptor (`server.js`):** Express interceptor on port 3000 with a 50MB body-parser limit to handle massive context windows and repository payloads cleanly.
* ✅ **Dual Route Handling:** Handles both `/chat/completions` and `/v1/chat/completions` to support standard OpenAI-compatible coding extensions and agents.
* ✅ **Claude Code Support (Anthropic `/v1/messages`):** The Interceptor accepts the Anthropic Messages format alongside OpenAI's, so Claude Code runs through the harness with `ANTHROPIC_BASE_URL=http://localhost:3000`. The Gateway translates tool use and streaming for non-Anthropic models; the Interceptor strips unsigned thinking blocks from history (no provider accepts them back) and ignores `<system-reminder>` text when routing.
* ✅ **Size-Aware Free Tier:** Groq's free tier caps every text model at 8K tokens/min (input plus requested output), which no Claude Code request fits under. The Interceptor sends the Router a size estimate; weak requests over 7K tokens go to OpenRouter's free tier instead of failing on Groq first. Groq now serves GPT-OSS 120B, which has the same free limits as the 20B.
* ✅ **Router as a Classifier Service (`router.py`):** RouteLLM's bundled proxy server rejected tool schemas, couldn't carry the Anthropic format, and needed an OpenAI key even for BERT. The Router now only answers "strong or weak?"; the Interceptor sends the request to the Gateway itself. If the Router is down, requests degrade to the free tier instead of failing.
* ✅ **LiteLLM Proxy Tier (Port 4000):** Central fallback chain via `config.yaml`, routing across local wrappers and free-tier APIs.
* **Local Qwen 3 Coder Launch Flags:** Finish hardening `launch-local.sh` for Qwen 3 Coder:
  * ✅ Clamp local context length (`-c 8192`) to prevent VRAM memory crashes.
  * Pass `--chat-template-kwargs '{"preserve_thinking": true}'` to prevent tool calls from stalling inside reasoning blocks.
  * Enforce stop tokens (`<|endoftext|>` ID: `151643` & `<|im_end|>` ID: `151645`) to prevent Fill-In-the-Middle (FIM) autocomplete loops.

## Phase 2: Intelligent Complexity Routing ✅
* ✅ **Local BERT Classifier Integration:** RouteLLM on port 6060 uses the local `bert` router instead of matrix factorization (`mf`), bypassing the need for external embedding API keys (`text-embedding-3-small`).
* ✅ **Three-Part Model Mutation:** Strict `router-bert-[threshold]` model names in `server.js` prevent RouteLLM parser crashes (`ValueError`).
* ✅ **Dynamic Cost Thresholds:** The Interceptor scores only the text typed in the latest user turn (string or text blocks). The system prompt and tool output are never scored, since they mention "test"/"debug"/"design" constantly and pinned nearly every request at the 0.5 default. Turns carrying only tool results keep the routing of the request that started them.
* ✅ **Concurrency Throttling (Gateway):** Per-deployment `max_parallel_requests` in `config.yaml` (CLI wrapper 1 per alias → 2 total, Groq 3, OpenRouter 5). Bursts queue in LiteLLM instead of tripping provider rate limits. This lives in the Gateway rather than the Interceptor because only the Gateway knows which provider a request finally hits. A local Qwen deployment gets a cap of 10 when it is added to the model list.
* ✅ **Context Anchor (within one request):** A tool result identical to an earlier one in the same request (a re-read file, a re-run command) is replaced with a pointer to the first copy's tool ID. The first copy is always kept, so earlier messages never change and provider prompt caches stay valid. Results under 500 chars, images, and anything the user typed are left alone.
  * Anchoring across requests or model handoffs needs memory the stateless core doesn't have; that part moves to the Orchestrator add-on as **Cross-Session Context Handoff**.

## Phase 3: Zero-Cost Token & Context Compression
* ✅ **Caveman Output Compression:** The Interceptor injects the `CAVEMAN_PROMPT` system instruction (`"Be terse. Do not restate context. Do not use preamble text."`) to slash expensive output tokens by ~65%.
* ✅ **Headroom Compression (in the Interceptor):** Tool outputs are cleaned of noise and truncated from the middle past 4,000 chars, keeping the tail where errors usually land.
  * **Headroom MCP Server:** Optionally wire Headroom as an MCP server to intercept tool outputs at the agent, dropping code search token overhead by up to 92%.
* ✅ **Standing Context Trimming:** `caveman-compress` trims standing workspace memory files (`CLAUDE.md`, `GLOSSARY.md`, `.qwen/settings.json`) to minimize foundational overhead before execution.

## Phase 4: Local Model Resilience & Lifecycle Management ✅
* ✅ **Local Engine Hardening (`llama.cpp` / vLLM):** Anti-looping parameters for local models (such as Qwen 3 Coder and Gemma 4) using explicit context limits (`-c 8192`), layer offloading (`-ngl`), and reasoning budget controls (`--reasoning-budget 2048`).
* ✅ **Non-Breaking Space Validation:** `validate-config.js` enforces valid UTF-8 spacing across configuration directories to prevent silent JSON parser crashes in VS Code extensions.
* ✅ **Automated Deprecation Fallbacks:** LiteLLM fallback chains substitute deprecated models (such as legacy Llama variants) with active free-tier workhorses like OpenAI GPT-OSS 120B.

## Ideas for Later
* ✅ **Free VPS Hosting (Docker):** `docker compose up -d --build` runs the Interceptor, Router and Gateway as containers on a server; README "Run it on a server" walks through Oracle Cloud Always Free with Tailscale. About 450 MB of memory with the `systemone` Router, so 1 GB free tiers fit too; the RouteLLM BERT Router is a build option (`ROUTER_BACKENDS=routellm`, ~2 GB more). The local engine and Ollama don't run there, so strong requests use OpenRouter fallbacks.
  * ✅ **Access control:** `HARNESS_PASSWORD` locks every page and API (browser login box, or the agent's API key), and the Docker setup won't start without it.
  * ✅ **Task runner as a container (`COMPOSE_PROFILES=runs`):** `docker/runner.Dockerfile` runs the runner beside the Interceptor, reached as `http://runner:3100` with a shared `RUNNER_TOKEN`; run records and branches stay in `./runs` and `./repos`. Agents work in an E2B cloud sandbox (`RUNNER_SANDBOX=e2b`), so the image needs no language toolchains and agent commands never run in a container that has the host's folders mounted.

---

# Runner: Cloud Sandboxes (E2B) ✅

Agent runs can work in a Linux VM from [E2B](https://e2b.dev) instead of a worktree on this machine, so `run_command` and the file tools never touch the host. Set `RUNNER_SANDBOX=e2b` and `E2B_API_KEY` in `.env`; nothing else changes for workflows, tools, the command guard, approvals or the Runs page.

* ✅ **`E2BSandbox` behind the `LocalSandbox` interface:** `runner/sandbox.js` exports both with the same methods (`resolve`, `readFile`, `writeFile`, `listDir`, `exec`, `git`, `commit`, `diffStat`, `diff`, `sync`, `destroy`), and `createSandbox`/`attachSandbox` pick one, so `runs.js`, `tools.js` and `swarm.js` never know which they got. The e2b module is required lazily, so a local setup needs no key and no network.
* ✅ **Branch in and out as a git bundle:** the base commit is packed here and written into a fresh sandbox (`E2B_TEMPLATE`, default `base`), which checks it out on its own `harness/<id>` branch in `E2B_WORKDIR`; at the end everything is committed, packed back and fetched into the local repo, so `git diff`, **Continue**, **Retry** and pushing all work as with a local run. A base that is not a branch tip packs with its full history; a carried-on branch sends only the commits made since the base.
* ✅ **Swarm support:** each worker's branch is handed *to* the swarm's sandbox before the merge, and the swarm's merged branch is handed back after.
* ✅ **Billing stops with the run:** the sandbox is killed when the run ends and when a restart finds a run that was in progress; `destroyById` covers one whose process died. `E2B_API_KEY` is never passed into the commands the agent runs (the trimmed env allowlist applies here too).
* ✅ **Tests:** `test/e2bSandbox.test.js` covers the start point, the handed-back branch, an unchanged run, exit codes and timeouts, workspace bounds, a swarm merge, `createSandbox`'s choice and error, and a non-tip base, with a stand-in for `e2b` so it needs neither network nor key.
* **Not done:** no real-key smoke test yet (mocked only), and `E2B_WORKDIR`/template choice is per-runner, not per-run.
* ✅ **Terminal panel on the Agents page (formerly Runs):** xterm.js (vendored in `ui/vendor/xterm/`) replays a run's commands and output as the page refreshes. **Not done:** an interactive shell in the sandbox, and streaming output while a long command is still running (it appears when the command ends).

---

# Add-on: Orchestrator

Optional, higher-level operation built on top of the Model Layer. State lives on GitHub issues ([ADR 0001](docs/adr/0001-tracker-is-the-orchestrators-only-state.md)).

* **Multi-Session Orchestration (`/wayfinder`):** Claude Code command maps project destinations, records "fog of war" domain questions, and drafts a topologically ordered JSON ticket matrix. The draft is review-only; GitHub issue creation and dispatch remain future work.
* **Interactive State Interrogation (`/grill-me` & `/grill-with-docs` via Claude Opus 5):** Run multi-round interview sessions on architectural decision tickets to update domain models, `CONTEXT.md`, and Architectural Decision Records (ADRs) prior to writing code. Grilling is HITL and happens in the human's own session.
  * **Voice Grilling (STT/TTS):** Voice lives client-side in Claude Code, not in the Orchestrator or Model Layer.
    * ✅ **MVP TTS:** `.claude/hooks/speak.js` Stop hook reads each reply aloud via Windows `System.Speech` when `GRILL_VOICE=1` is set; strips code blocks and markdown, and cuts off stale speech when a new reply arrives.
    * ✅ **MVP STT:** No code — answer with Windows dictation (`Win+H`) or Claude Code `/voice` push-to-talk.
    * **Natural Local Voices:** Swap `System.Speech` for Piper or Kokoro (free, local) behind the same hook.
    * **Voice-Mode Prompting:** When `GRILL_VOICE` is set, instruct the grilling skill to ask one short question per turn, state its recommended answer in one sentence, and avoid tables and option menus.
    * **Glossary-Primed Transcription:** Run Whisper (local or Groq free tier) with `CONTEXT.md` glossary terms in its `prompt` parameter so domain words (Orchestrator, Build Ticket, ADR) transcribe correctly.
    * **Gateway Audio Routes (optional):** Add `/v1/audio/transcriptions` and `/v1/audio/speech` pass-through to the Interceptor so audio calls use LiteLLM fallbacks like chat does. Only if dictation accuracy becomes a real problem.

* ✅ **Parallel Worker Fan-Out (from a ticket draft):** a swarm can take the `/wayfinder` JSON draft instead of planning (`runner/tickets.js`): build tickets run in dependency waves, each worker on its own branch, merged into the swarm branch, then reviewed. **Not done:** creating the GitHub issues, reading Ready marks from the tracker, and writing the status comment (ADR 0001).

* **Agentic Teams (ChatDev vs. build in-house):** Evaluate ChatDev against extending the existing Runner/Orchestrator with collaborating specialist agents. Compare integration effort, fit with isolated worktrees and ticket state, model flexibility, and operational overhead; choose an approach and define a small MVP before committing to a framework.

* **Adversarial Audit & Closed-Loop Refactoring:** Run a short Opus 5 Audit over each Worker's pull request. If rejected, route a concise JSON critique back to the Worker for refactoring without burning high-cost frontier output tokens.
* **Cross-Session Context Handoff:** When work moves between Workers or models, pass hash pointers (`Ref ID`) and Git diffs instead of re-sending full workspace files, backed by a local cache.

# Bugs
* **Allow Tool Call messages should surface and show a clear indicator of user input being needed

# Additional

* ✅ **Advisor as a real command (`/advisor MODEL`):** Set a model as an advisor and give the chat's model an `ask_advisor` tool for second opinions. Short names match a served Gateway model; `/advisor` reports the current setting and `/advisor off` removes it. The advisor answers in one plain request with no tools of its own, and its cost is counted with the calling reply.
* **Subagent spawning (`/subagent`):** Spawn a subagent for an individual task, with its own model — default a cheaper, lower tier than the chat's — and its own tool budget. The parent chat gets the subagent's summary back as a tool result, so research and grunt work run on the cheap model while the parent keeps the thread.
* **Plan mode:** A mode in which the agent reads, searches and reasons but makes no changes. Every write and every mutating command is refused with "plan mode", the agent finishes with a plan instead of a diff, and a button turns the plan into a normal run. Fits the existing tool sets: plan mode is the `read`/`check` toolset plus a refusal in `makeTools`, not a new sandbox.
* **One working tree per chat:** Chats linked to the same repo currently share the user's working copy, so a chat's `run_command` (and its uncommitted edits) interfere with other chats and with runs. Give each chat its own worktree on its own branch, created on link and reused across turns, so concurrent chats and runs never see each other's changes.
* **Queue a message into a thinking chat:** Sending into a chat that is still replying is refused ("Stop the current reply first"). Instead queue the message; when the reply finishes, the queued one is sent in order, with the queued messages shown in the composer.
* **Thinking pane keeps its place:** While a reply streams, an open thinking pane jumps to the newest text on every redraw, so scrolling up is impossible. Follow only while you are at the bottom; once you scroll up, stay where you are and show a **scroll to bottom** button in the pane to jump back (and re-arm following).
* **Fix the thinking animation that outlives the thinking:** `.spark i { animation-delay: inherit }` in `ui/chat.css` inherits the `.thinking` frame delay, so the dots keep hopping after the reply stops streaming. Give them their own delays, and stop the animation when the message is no longer streaming.

## Failing tests to fix

From `testout.txt` (264/282 passing):

* **`access.test.js` (2):** the harness password and API keys sent as `x-api-key`/`Bearer` reach the Gateway instead of being stripped (`seen.authorization`, `seen['x-api-key']`).
* **`login.test.js` (2):** same credential leak through the login gate, and `users.json` is created world-readable (`mode & 0o077` is `54`, not `0`).
* **`gateway.test.js` (2):** a Gateway that resets the connection is not retried — the error never reaches the retry middleware, so the request hangs until the client times out.
* **`gatewayConfig.test.js` (3):** resolved for the shipped `config.yaml` (its fallback chains had been deleted and are restored); the remaining fixture assertions depend on LF line endings — see `.gitattributes`.
* **`calm.test.js` (1):** the test's `@media (hover: hover)` stripping regex misses the blocks in `ui/calm.css`, so hiding rules look like they sit outside the media query.
* **`mcp.test.js` (1):** a stdio server that times out once is not retried — the second connect never lists tools (`test/fixtures/flaky-mcp-server.js`).