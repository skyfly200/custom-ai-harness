# Custom AI Harness: Technical Roadmap

This roadmap outlines the strategic upgrades for the `custom-ai-harness` repository. It builds upon our multi-tier local proxy architecture to optimize token consumption, integrate local compression and routing intelligence, and harden execution against local model loops.

---

## Phase 1: Architecture Stabilization & Core Routing
* **Unified Service Interceptor (`servers.js`):** Ensure the Express interceptor runs on port 3000 with a 50MB body-parser limit to handle massive context windows and repository payloads cleanly.
* **Dual Route Handling:** Configure the Node.js middleware to handle both `/chat/completions` and `/v1/chat/completions` seamlessly to support standard OpenAI-compatible coding extensions and agents.
* **LiteLLM Proxy Tier (Port 4000):** Maintain the central fallback chain via `config.yaml`, routing requests securely across local wrappers and free-tier APIs.

## Phase 2: Intelligent Complexity Routing (RouteLLM & BERT)
* **Local BERT Classifier Integration:** Run RouteLLM on port 6060 using the local `bert` router instead of matrix factorization (`mf`), completely bypassing the need for external embedding API keys (`text-embedding-3-small`).
* **Three-Part Model Mutation:** Enforce strict three-part model name formatting (`router-bert-[threshold]`) in `servers.js` to prevent parser crashes (`ValueError`).
* **Dynamic Cost Thresholds:** Calibrate complexity boundaries so that simple boilerplate tasks, tests, and refactors automatically route to free fallback tiers while complex logic retains strong model support.

## Phase 3: Zero-Cost Token & Context Compression
* **Caveman Output Compression:** Automatically inject the `CAVEMAN_PROMPT` system instruction (`"Be terse. Do not restate context. Do not use preamble text."`) to slash expensive output tokens by ~65%.
* **Headroom Engine Integration:** Wire Headroom as an MCP server or local proxy wrapper to intercept tool outputs, logs, and files, dropping code search token overhead by up to 92%.
* **Standing Context Trimming:** Apply `caveman-compress` routines to standing workspace memory files (`CLAUDE.md`, `.qwen/settings.json`) to minimize foundational overhead before execution.

## Phase 4: Local Model Resilience & Anti-Looping
* **Local Engine Hardening (`llama.cpp` / vLLM):** Implement strict anti-looping parameters for local models (such as Qwen Coder and Gemma 4) using explicit context limits (`-c 8192`), layer offloading (`-ngl`), and reasoning budget controls (`--reasoning-budget 2048`).
* **Non-Breaking Space Validation:** Prevent silent JSON parser crashes in VS Code extensions by strictly enforcing valid UTF-8 spacing across configuration directories.
* **Automated Deprecation Fallbacks:** Routinely update LiteLLM fallback chains to substitute deprecated models (such as legacy Llama 3/3.1 variants) with active free-tier workhorses like OpenAI GPT-OSS 20B.