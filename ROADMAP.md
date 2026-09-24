# Custom AI Harness: Technical Roadmap

This roadmap outlines the strategic upgrades for the `custom-ai-harness` repository. It builds upon our multi-tier local proxy architecture to optimize token consumption, integrate local compression and routing intelligence, and harden execution against local model loops.

---

## Phase 1: Architecture Stabilization & Core Routing
* **Unified Service Interceptor (`servers.js`):** Ensure the Express interceptor runs on port 3000 with a 50MB body-parser limit to handle massive context windows and repository payloads cleanly.
* **Dual Route Handling:** Configure the Node.js middleware to handle both `/chat/completions` and `/v1/chat/completions` seamlessly to support standard OpenAI-compatible coding extensions and agents.
* **LiteLLM Proxy Tier (Port 4000):** Maintain the central fallback chain via `config.yaml`, routing requests securely across local wrappers and free-tier APIs.
* **Tier 0 Pre-Triage Sensor (Qwen 3 Coder):** Deploy local Qwen 3 Coder (`http://localhost:8080` / `11434`) to resolve basic syntax issues, missing imports, and log errors before escalating to paid or frontier models.
  * Clamp local context length (`-c 8192`) to prevent VRAM memory crashes.
  * Pass `--chat-template-kwargs '{"preserve_thinking": true}'` to prevent tool calls from stalling inside reasoning blocks.
  * Enforce stop tokens (`<|endoftext|>` ID: `151643` & `<|im_end|>` ID: `151645`) to prevent Fill-In-the-Middle (FIM) autocomplete loops.

## Phase 2: Intelligent Complexity Routing & Parallel Execution
* **Local BERT Classifier Integration:** Run RouteLLM on port 6060 using the local `bert` router instead of matrix factorization (`mf`), completely bypassing the need for external embedding API keys (`text-embedding-3-small`).
* **Three-Part Model Mutation:** Enforce strict three-part model name formatting (`router-bert-[threshold]`) in `servers.js` to prevent parser crashes (`ValueError`).
* **Dynamic Cost Thresholds:** Calibrate complexity boundaries so that simple boilerplate tasks, tests, and refactors automatically route to free fallback tiers while complex logic retains strong model support.
* **Concurrency Throttling (`p-limit`):** Throttling parallel API calls based on provider limits (1–2 for Claude CLI Wrapper on Port 8000, 5 for Groq/Gemini, 10 for local Qwen Coder).
* **OSPF-Style Zero-Duplication Context Anchor:** Prevent re-sending full workspace files during model handoffs by storing context in local Headroom/Redis caches and transmitting only hash pointers (`Ref ID`) and Git diffs.

## Phase 3: Pocock Skill Engine Integration & Context Compression
* **Multi-Session Orchestration (`/wayfinder` via Claude Sonnet 4.6):** Invoke Sonnet 4.6 to map project destinations, track "fog of war" domain questions, and break goals down into a JSON/DAG ticket matrix.
* **Interactive State Interrogation (`/grill-me` & `/grill-with-docs` via Claude Opus 5):** Intercept architectural decision tickets and run multi-round interview sessions with Opus 5 to update domain models, `GLOSSARY.md`, and Architectural Decision Records (ADRs) prior to writing code.
* **Parallel Worker Fan-Out:** Automatically dispatch cleared build tickets to parallel local Qwen 3 Coder or Groq instances.
* **Adversarial Audit & Closed-Loop Refactoring:** Run a short Opus 5 review pass over completed code outputs. If rejected, route concise JSON critiques back to Qwen 3 Coder for refactoring without burning high-cost frontier output tokens.
* **Caveman Output Compression:** Automatically inject the `CAVEMAN_PROMPT` system instruction (`"Be terse. Do not restate context. Do not use preamble text."`) to slash expensive output tokens by ~65%.
* **Headroom Engine Integration:** Wire Headroom as an MCP server or local proxy wrapper to intercept tool outputs, logs, and files, dropping code search token overhead by up to 92%.
* **Standing Context Trimming:** Apply `caveman-compress` routines to standing workspace memory files (`CLAUDE.md`, `GLOSSARY.md`, `.qwen/settings.json`) to minimize foundational overhead before execution.

## Phase 4: Local Model Resilience & Lifecycle Management
* **Local Engine Hardening (`llama.cpp` / vLLM):** Implement strict anti-looping parameters for local models (such as Qwen 3 Coder and Gemma 4) using explicit context limits (`-c 8192`), layer offloading (`-ngl`), and reasoning budget controls (`--reasoning-budget 2048`).
* **Non-Breaking Space Validation:** Prevent silent JSON parser crashes in VS Code extensions by strictly enforcing valid UTF-8 spacing across configuration directories.
* **Automated Deprecation Fallbacks:** Routinely update LiteLLM fallback chains to substitute deprecated models (such as legacy Llama variants) with active free-tier workhorses like OpenAI GPT-OSS 20B.