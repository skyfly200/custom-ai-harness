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

---

# Add-on: Orchestrator

Optional, higher-level operation built on top of the Model Layer. State lives on GitHub issues ([ADR 0001](docs/adr/0001-tracker-is-the-orchestrators-only-state.md)).

* **Multi-Session Orchestration (`/wayfinder` via Claude Sonnet 4.6):** Invoke Sonnet 4.6 to map project destinations, track "fog of war" domain questions, and break goals down into a JSON/DAG ticket matrix.
* **Interactive State Interrogation (`/grill-me` & `/grill-with-docs` via Claude Opus 5):** Run multi-round interview sessions on architectural decision tickets to update domain models, `CONTEXT.md`, and Architectural Decision Records (ADRs) prior to writing code. Grilling is HITL and happens in the human's own session.
  * **Voice Grilling (STT/TTS):** Voice lives client-side in Claude Code, not in the Orchestrator or Model Layer.
    * ✅ **MVP TTS:** `.claude/hooks/speak.js` Stop hook reads each reply aloud via Windows `System.Speech` when `GRILL_VOICE=1` is set; strips code blocks and markdown, and cuts off stale speech when a new reply arrives.
    * ✅ **MVP STT:** No code — answer with Windows dictation (`Win+H`) or Claude Code `/voice` push-to-talk.
    * **Natural Local Voices:** Swap `System.Speech` for Piper or Kokoro (free, local) behind the same hook.
    * **Voice-Mode Prompting:** When `GRILL_VOICE` is set, instruct the grilling skill to ask one short question per turn, state its recommended answer in one sentence, and avoid tables and option menus.
    * **Glossary-Primed Transcription:** Run Whisper (local or Groq free tier) with `CONTEXT.md` glossary terms in its `prompt` parameter so domain words (Orchestrator, Build Ticket, ADR) transcribe correctly.
    * **Gateway Audio Routes (optional):** Add `/v1/audio/transcriptions` and `/v1/audio/speech` pass-through to the Interceptor so audio calls use LiteLLM fallbacks like chat does. Only if dictation accuracy becomes a real problem.
* **Pre-triage (Qwen 3 Coder):** Before an Escalation, have local Qwen 3 Coder (`http://localhost:8080` / `11434`) attempt a concrete failure (broken build, failing test, error log).
* **Parallel Worker Fan-Out:** Dispatch Ready Build Tickets to parallel Workers (local Qwen 3 Coder or Groq), each in its own branch and worktree.
* **Adversarial Audit & Closed-Loop Refactoring:** Run a short Opus 5 Audit over each Worker's pull request. If rejected, route a concise JSON critique back to the Worker for refactoring without burning high-cost frontier output tokens.
* **Cross-Session Context Handoff:** When work moves between Workers or models, pass hash pointers (`Ref ID`) and Git diffs instead of re-sending full workspace files, backed by a local cache.
