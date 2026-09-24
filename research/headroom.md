# Headroom: what it is, and should it replace the homegrown compressor?

Research for [#7](https://github.com/skyfly200/custom-ai-harness/issues/7) (map [#3](https://github.com/skyfly200/custom-ai-harness/issues/3)). Researched 2026-09-24 against Headroom `v0.38.0` (released 2026-09-21) and `main` of the upstream repo.

## TL;DR

- **"Headroom" is `headroomlabs-ai/headroom`** (formerly `chopratejas/headroom`), an Apache-2.0 context-compression layer with a Rust core and Python/TypeScript SDKs. It ships as a library, an OpenAI/Anthropic-compatible **proxy**, an **MCP server**, and `headroom wrap <agent>`. Which project the roadmap means is not in doubt: its "up to 92%" code-search figure is word for word from that repo's old README.
- **The 92% figure is withdrawn.** Upstream replaced it on 2026-09-02 with a seeded, reproducible benchmark. That benchmark gives **21% on code search** (17,199 → 13,597 tokens), and 30–57% on the other agent scenarios. The upstream script says the old figures "could not be reproduced by anyone, including us."
- **It fits this proxy chain.** The proxy serves `/v1/chat/completions` and can point at any OpenAI-compatible upstream (`--openai-api-url` / `OPENAI_TARGET_API_URL`). It also has a compression-only endpoint (`POST /v1/compress`) that our Node Interceptor could call as a sidecar, leaving routing where it is.
- **It is safer than `server.js`, not just smaller.** Headroom compresses by content type, never touches user messages or source code by default, returns the original whenever a compressor fails, and keeps originals so the model can fetch them with `headroom_retrieve` (CCR). `server.js` silently cuts every `user`/`tool` message at 4000 characters and drops array blocks after index 20, with no marker saying anything was cut.
- **Recommendation:** replace the homegrown truncator with Headroom as a `/v1/compress` sidecar called from the Interceptor. Start with CCR off (`lossy_inline`/default marker-free pipeline), because in-band retrieval needs the model to make a tool call and the local Qwen tier may not do that reliably. At a minimum, stop truncating `user` messages today and add a truncation marker.

## 1. Identifying the project

| Candidate | Status |
|---|---|
| [`headroomlabs-ai/headroom`](https://github.com/headroomlabs-ai/headroom) | **The one.** ~73.7k stars, Apache-2.0, pushed 2026-09-24, latest release `v0.38.0` (GitHub API). |
| [`chopratejas/headroom`](https://github.com/chopratejas/headroom) | The same repo before it moved to the org: the GitHub API resolves it to `headroomlabs-ai/headroom`. Articles and older links still use this name. |
| `edcariati/headroom`, `leotorrealba/headroom`, `kapoorsunny/headroom` | Forks with the upstream's description. Not separate projects. |

This is the roadmap's source: the README of `headroomlabs-ai/headroom` carried the table row `Code search (100 results) | 17,765 | 1,408 | 92%` from at least 2026-02-19 until commit [`7c4d696`](https://github.com/headroomlabs-ai/headroom/commit/7c4d696cf92c991ef839be47d6e600b716d67767) (2026-09-02). ROADMAP.md's "intercept tool outputs, logs, and files … up to 92%" paraphrases the repo tagline "Compress tool outputs, logs, files, and RAG chunks before they reach the LLM." The roadmap's "Headroom/Redis caches" (Phase 2) matches Headroom's CCR store, which ships only `sqlite` (the default) and `memory` backends. Redis would have to be a third-party plugin through an entry point ([ccr.mdx](https://github.com/headroomlabs-ai/headroom/blob/main/docs/content/docs/ccr.mdx)).

## 2. What it compresses, and how

Pipeline, from the [README "How it works"](https://github.com/headroomlabs-ai/headroom#how-it-works): `CacheAligner → ContentRouter → {SmartCrusher | CodeCompressor | Kompress-v2-base} → CCR`.

- **ContentRouter** works out what kind of content each block is (Magika is one of the classifiers) and sends it to the matching compressor.
- **SmartCrusher (JSON arrays):** keeps an adaptive number K of items. K is set from Kneedle on bigram coverage, SimHash near-duplicate detection and a zlib diversity check, then split 30% from the start, 15% from the end and 55% by importance score. It **always** keeps error items (matching "error", "exception", "failed", "critical"), numeric and string-length outliers beyond 2σ, and change points, even when that exceeds K. `max_items_after_crush` defaults to 15 ([limitations.mdx](https://github.com/headroomlabs-ai/headroom/blob/main/docs/content/docs/limitations.mdx)).
- **CodeCompressor:** AST-aware (tree-sitter). In practice it rarely fires. Code in the last 4 messages is protected, and when the latest user message says "analyze/review/explain/fix/debug", all code is protected. Upstream's own numbers show **0% on Python source** ([benchmarks.mdx](https://github.com/headroomlabs-ai/headroom/blob/main/docs/content/docs/benchmarks.mdx)).
- **Kompress-v2-base:** a ModernBERT token-retention classifier for prose. It runs locally as ONNX, with an optional remote endpoint (`HEADROOM_KOMPRESS_ENDPOINT`) ([proxy.mdx](https://github.com/headroomlabs-ai/headroom/blob/main/docs/content/docs/proxy.mdx)).
- **Never compressed by default:** user messages (`skip_user_messages=True`), system prompts, messages under 50 tokens, **grep/search results** ("compact structured format, already minimal"), images, malformed JSON ([limitations.mdx](https://github.com/headroomlabs-ai/headroom/blob/main/docs/content/docs/limitations.mdx)).
- **Fail-open:** invalid JSON, AST parse failures, a missing dependency, or an output that comes out larger than the input all return the original unchanged (same source).
- **CCR (Compress-Cache-Retrieve):** the original is stored by hash, and a marker like `[1000 items compressed to 20. Retrieve more: hash=abc123]` goes into the output. A `headroom_retrieve` tool is injected, and on the OpenAI and Anthropic proxy paths the proxy handles those calls itself, so the client never sees them. Originals expire after 1 hour locally and 30 minutes in the proxy store (`HEADROOM_CCR_TTL_SECONDS`) ([ccr.mdx](https://github.com/headroomlabs-ai/headroom/blob/main/docs/content/docs/ccr.mdx), [mcp.mdx](https://github.com/headroomlabs-ai/headroom/blob/main/docs/content/docs/mcp.mdx)).
- **Also ships** features that overlap other roadmap items: output "verbosity steering", which appends terseness guidance much like our `CAVEMAN_PROMPT`; opt-in model routing (`HEADROOM_MODEL_ROUTER_ENABLED`); tool-schema compaction; and cross-agent memory ([README](https://github.com/headroomlabs-ai/headroom), [proxy.mdx](https://github.com/headroomlabs-ai/headroom/blob/main/docs/content/docs/proxy.mdx)).

**Privacy note:** `HEADROOM_BEACON` is **on by default**. It uploads anonymous counters: token totals, compression ratios, model IDs, OS. Turn it off with `HEADROOM_BEACON=off` or `DO_NOT_TRACK=1` ([limitations.mdx](https://github.com/headroomlabs-ai/headroom/blob/main/docs/content/docs/limitations.mdx)).

## 3. How it integrates

From the [README](https://github.com/headroomlabs-ai/headroom#what-it-does) and [proxy.mdx](https://github.com/headroomlabs-ai/headroom/blob/main/docs/content/docs/proxy.mdx):

| Mode | How | Notes for us |
|---|---|---|
| Proxy | `headroom proxy --port 8787 --openai-api-url <upstream>` | Serves `/v1/chat/completions`, `/v1/responses`, `/v1/messages`. Upstream set by `--openai-api-url` / `OPENAI_TARGET_API_URL`. Modes: `token` (default, may rewrite history) or `cache` (freezes earlier turns for prefix-cache stability). |
| Compression-only sidecar | `POST /v1/compress` with `{messages, model, config?}` | Returns compressed messages in the **same wire shape** (OpenAI `role:"tool"` or Anthropic `tool_result` blocks) and never calls an LLM. Loopback-only by default (other callers get a 404). `config.mode`: `ccr`, `lossy_inline`, `lossless_then_lossy`, or unset (marker-free default). Ignores `system`/`tools` outside "gateway mode". |
| Gateway mode | `/v1/compress` + `/v1/compress/response` two-half contract | Built for gateways that own routing (LiteLLM, Kong). Needed for in-band CCR when Headroom does not see the provider response. |
| MCP server | `headroom mcp serve` / `headroom mcp install` | Tools: `headroom_compress`, `headroom_retrieve`, `headroom_stats`. The **model** decides when to compress, so this does **not** transparently intercept tool output. |
| Library | Python `compress(messages, model=…)`, TS `await compress(messages, {model})` | The TS SDK calls the proxy's `/v1/compress`, so a Python process is still needed. The CLI ships only in the PyPI package. |
| LiteLLM callback | `litellm.callbacks = [HeadroomCallback()]` | Could live in our LiteLLM (port 4000) layer, but only in the Python app. We run LiteLLM from `config.yaml`, so check it is reachable from there before relying on it. |
| Agent wrap | `headroom wrap claude` etc. | Points the agent at its own proxy and installs Serena at user scope. That conflicts with our own port-3000 entry point, so not recommended here. |

### Does it work with this chain?

Our chain: `agent → :3000 Interceptor (Node) → :6060 RouteLLM → :4000 LiteLLM → tiers (:8000 local, Groq/Gemini …)`.

- **Yes, as an inline proxy.** The upstream docs have a whole page ([local-llm-prefill.mdx](https://github.com/headroomlabs-ai/headroom/blob/main/docs/content/docs/local-llm-prefill.mdx)) on running Headroom in front of an OpenAI-compatible local server (vLLM, LM Studio, Ollama, MLX) with `--openai-api-url http://127.0.0.1:8000`. It could sit between the Interceptor and RouteLLM (`:3000 → :8787 → :6060`). One caveat: our Interceptor rewrites `model` to `router-bert-<t>`, and Headroom uses `model` to pick a tokenizer and context limit, so it would fall back to guessing for that name.
- **Better, as a sidecar.** The Interceptor already has the parsed `messages`. It can `POST` them to `http://127.0.0.1:8787/v1/compress` with the **real** target model name and forward the result. That replaces `applyHeadroom()` with one HTTP call, keeps RouteLLM and LiteLLM untouched, and fails open (on error, forward the originals).
- **CCR is the risky part in our chain.** In-band retrieval needs the model to call `headroom_retrieve`, and it needs Headroom to see the provider response. Inline proxy mode gives it the response. Sidecar mode needs gateway mode with `can_redrive`, which is off for streaming. Weaker local models (the Qwen tier, and the looping failure modes Phase 4 handles) may ignore or mangle the extra tool. Start marker-free or `lossy_inline`, and try CCR later against the strong tier.

## 4. What savings it measures, and how

- **Current headline** (README "Proof" table, seeded and offline, provider tokenizer on the shipped `compress()`, reproduced by `uv run python benchmarks/index_proof_table.py --seed 20260902`):

  | Scenario | Before | After | Saved |
  |---|---:|---:|---:|
  | Code search (100 results) | 17,199 | 13,597 | **21%** |
  | SRE incident debugging | 55,957 | 24,340 | 57% |
  | Codebase exploration | 58,801 | 33,895 | 42% |
  | GitHub issue triage | 46,067 | 32,429 | 30% |

  The script's docstring ([`benchmarks/index_proof_table.py`](https://github.com/headroomlabs-ai/headroom/blob/main/benchmarks/index_proof_table.py)) says the earlier numbers came from an unseeded harness, so "the published figures could not be reproduced by anyone, including us." The old table read 92% / 92% / 73%.
- **Per content type** ([benchmarks.mdx](https://github.com/headroomlabs-ai/headroom/blob/main/docs/content/docs/benchmarks.mdx), `bench_latency.py`, v0.37.0): JSON search results 48–49%, structured logs 53–54%, documentation text 92%, Python source 0%. Latency is ~0.2–1.4 ms p50 per scenario.
- **Accuracy** (`python -m headroom.evals suite --tier 1`, N=100): GSM8K 0.870 → 0.870, TruthfulQA 0.530 → 0.560 (upstream says this is within the CI), SQuAD v2 97% at 19% compression, BFCL (tool use) 97% at 32% compression. On a 100-entry log array, the injected anomalous error entry survived compression (substring check, 38.2% compression).
- **Measuring on our own traffic:** `headroom savings`, `headroom dashboard`, `/stats`, Prometheus `headroom_tokens_saved_total`, and a `--no-optimize` passthrough baseline ([local-llm-prefill.mdx](https://github.com/headroomlabs-ai/headroom/blob/main/docs/content/docs/local-llm-prefill.mdx)). For our local tier the main benefit is shorter **prefill time**, not dollars. Upstream cites a community demo showing ~30% less prompt processing on a Mac.

**What this means for the roadmap:** "dropping code search token overhead by up to 92%" should be rewritten. Upstream now claims ~21% on code search and explicitly leaves grep-style output uncompressed. Expect the largest wins on JSON and log-heavy tool output and long sessions, and very little on source code and prose.

## 5. Comparison with `server.js`'s "Headroom"

`server.js` lines 58–97: `headroomCompressText` strips lines matching `^[-=*#]{4,}.*$`, trailing whitespace, and runs of three or more newlines, then applies `.slice(0, 4000)`. `headroomCompressContent` caps arrays with `.slice(0, 20)`. `applyHeadroom` applies both to every message with `role === 'tool'` **or `role === 'user'`**.

| | `server.js` truncator | Headroom |
|---|---|---|
| Strategy | Blind head truncation by character count | Content-aware: JSON statistical sampling, AST for code, ML for prose |
| Unit | Characters (4000), regardless of tokenizer or model context | Tokens, per-model tokenizer and context limit |
| Scope | Every `user` and `tool` message, including the human's own prompt | Tool outputs and live-zone content. User messages, system prompt and recent code skipped by default |
| What survives | The first 4000 chars and the first 20 blocks | Head + tail + errors + outliers + change points, so anomalies are kept by design |
| Signalling | **None.** The model cannot tell anything was cut | Marker with counts and a hash (CCR mode). Marker-free default is still selective, not blind |
| Reversibility | None | CCR: the original can be retrieved by hash for the TTL |
| Failure mode | Always applies | Fails open and returns the original on any error or non-shrinking result |
| Cost | Zero dependencies, microseconds | Python sidecar, ML models in process (CPU/RAM), ~ms |

### Silent-truncation risks in the current code (concrete)

1. **User prompts are truncated.** Because `role === 'user'` is matched, a pasted stack trace, spec or file over 4000 chars is cut with no notice. This is the most likely way the current code drops something the model needs.
2. **Errors live at the tail.** Build, test and log output usually puts the failure summary last. Head truncation keeps the noise and drops the `FAILED`/`FATAL` line. Headroom's demo shows the opposite result (10,144 → 1,260 tokens with the FATAL line kept).
3. **No marker.** The model sees text that stops mid-token or mid-JSON with nothing telling it the output was cut. That encourages confident answers from partial data, or repeated re-reads, which feeds the looping Phase 4 tries to stop.
4. **Array cap drops blocks positionally.** In Anthropic-shaped user turns, `tool_result` blocks after index 20 are dropped. That separates them from their `tool_use` IDs, and strict providers reject the request. The same slice drops images and other parts too.
5. **Invalid JSON.** Cutting a JSON tool result at 4000 chars produces unparseable JSON. Headroom's output "is valid JSON."
6. **`DECOR_RE` removes meaningful lines.** Any line starting with four or more of `- = * #` goes: Markdown `####` headings, `#####` comment banners, diff lines such as `----foo` (a removed line beginning `---`), and the rest of that line with them.
7. **Char cap applied uniformly to history.** Every earlier tool result is recompressed on every turn. That is idempotent, so the cost is low, but it rules out any "retrieve more" path.

What `server.js` does well: zero dependencies, deterministic, and it never makes a payload larger. The whitespace and blank-line normalisation is harmless and could stay as a cheap pre-pass.

## 6. Recommendation

1. **Replace `applyHeadroom()` with a call to Headroom's `/v1/compress`** from the Interceptor. Keep a strict timeout and fail open to the uncompressed messages. Run `headroom proxy` (with `HEADROOM_BEACON=off`) as another launch-script service next to RouteLLM and LiteLLM. Pass the real target model name for tokenization, not `router-bert-*`.
2. **Start without CCR.** Enable it only after testing that the strong and weak tiers actually call `headroom_retrieve`, and only in a mode where Headroom sees responses (inline proxy, or gateway mode for non-streaming requests).
3. **Before any migration, fix the worst of `server.js` cheaply:** stop compressing `role: 'user'` text, keep the tail as well as the head (or at least append `[truncated N chars]`), and never drop `tool_result` blocks.
4. **Update ROADMAP.md's claim.** The "92%" came from a benchmark upstream has withdrawn. Measure our own savings with `headroom savings` and a `--no-optimize` baseline instead.
5. **Watch the overlaps:** Headroom's verbosity steering against `CAVEMAN_PROMPT`, and its opt-in model router against RouteLLM. Leave those Headroom features off so each concern has one owner.

## Sources

- Repo and README: https://github.com/headroomlabs-ai/headroom (GitHub API metadata, release `v0.38.0`)
- README history: commit `7c4d696` (2026-09-02) replaced the 92% table; earlier versions such as `f699375f8f` (2026-02-19) carry it
- `benchmarks/index_proof_table.py`: https://github.com/headroomlabs-ai/headroom/blob/main/benchmarks/index_proof_table.py
- Docs (repo sources under `docs/content/docs/`): `benchmarks.mdx`, `limitations.mdx`, `ccr.mdx`, `mcp.mdx`, `proxy.mdx`, `local-llm-prefill.mdx`. Rendered at https://docs.headroomlabs.ai/docs
- This repo: `server.js` lines 50–111, `ROADMAP.md` lines 21 and 29
