# Which free-tier models can act as Workers?

Research for issue #6 (map #3). All numbers were read on **2026-09-24** unless a
different date is given. Free-tier catalogs change weekly; re-check before relying
on any row.

A **Worker** gets one Build Ticket, works in its own worktree and branch, and delivers
a PR. That takes a multi-turn tool-calling loop (read files, edit, run tests, commit),
so a candidate needs three things: reliable tool calls, enough context and tokens per
minute to carry a growing conversation, and enough daily requests to finish a ticket.

## TL;DR

- **Groq's free tier cannot run a real Worker loop.** Every free chat model is capped
  at **8K tokens per minute (TPM)**, counting input and output (2026-09-24). One
  agentic turn with a system prompt, tool schemas and a few files open goes past 8K,
  so Groq free is only good for single-shot Pre-triage or patch drafts. The current
  `groq/openai/gpt-oss-20b` default is the wrong Worker model for this reason.
- **OpenRouter `:free` models are the real Worker pool.** They have no token cap, only
  **20 RPM** plus **50 requests/day, or 1,000/day once $10 of credits has ever been
  bought** (2026-09-24). **Spending that one-time $10 is the biggest single unlock.**
  At 50/day you get about one small ticket a day. At 1,000/day you get about 10 to 20.
- **Best Worker candidate: `qwen/qwen3.8-27b:free`.** SWE-bench Pro 61.7 and
  Terminal-Bench 2.1 73.0, both vendor-reported, and the SWE-bench Pro run used the
  *Claude Code harness*. It has a 262K context and 100% endpoint uptime. Backups:
  `poolside/laguna-s-2.1:free` and `thinkingmachines/inkling:free`.
  `nex-agi/nex-n2.5-pro:free` benchmarks highest but its endpoint was degraded
  (83.7% uptime) when read.
- **`openrouter/free` should not be a Worker.** It picks a random capable free model
  on every request, including 2.6B-class models, so quality changes mid-session.
  Keep it only as the last fallback.
- **Every benchmark below is vendor-reported, each on a different harness.** Treat
  the ranking as a shortlist for a bake-off on real Build Tickets, not as a final
  verdict.

## Free-tier limits by provider

### Groq (free plan)

Source: <https://console.groq.com/docs/rate-limits>, read 2026-09-24.

| Model ID | RPM | RPD | TPM | TPD |
|---|---|---|---|---|
| `openai/gpt-oss-120b` | 30 | 1K | 8K | 200K |
| `openai/gpt-oss-20b` | 30 | 1K | 8K | 200K |
| `qwen/qwen3.8-27b` | 30 | 1K | 8K | 200K |

- Input and output tokens both count toward TPM/TPD. Cached tokens do not.
  Limits apply per organization. (rate-limits page, 2026-09-24)
- The page does not say what happens when one request is bigger than the TPM
  limit. *Inference, not verified:* a request over 8K tokens will be rejected, so
  any agent whose system prompt plus tool schemas is over ~8K (Claude Code's is)
  cannot use Groq free at all.
- Budget: 200K TPD ÷ ~6K tokens per call ≈ **~30 useful calls a day** per model.
- Other Groq models (`llama-3.3-70b-versatile`, `llama-3.1-8b-instant`,
  `minimaxai/minimax-m2.7`) are marked *Enterprise* on the models page and are not
  in the free table (<https://console.groq.com/docs/models>, 2026-09-24).

Model facts (models page and <https://console.groq.com/docs/tool-use>, 2026-09-24):

| Model | Context | Max output | Tool use | Parallel tool calls | Status |
|---|---|---|---|---|---|
| `openai/gpt-oss-120b` | 131,072 | 65,536 | yes | **no** | production |
| `openai/gpt-oss-20b` | 131,072 | 65,536 | yes | **no** | production |
| `qwen/qwen3.8-27b` | 131,072 | 16,384 | yes | yes | preview |

"All models hosted on Groq support tool use." Only the gpt-oss models get Groq's
built-in browser and code-execution tools (tool-use page, 2026-09-24).

### OpenRouter (`:free` variants)

Source: <https://openrouter.ai/docs/api-reference/limits>, read 2026-09-24.

- **20 RPM** for everyone.
- **50 requests/day** if less than $10 of credits has ever been bought, and
  **1,000/day** once at least $10 has been bought. The higher cap starts at $9.
- There is no TPM limit on free models. You can also get a 429 from the
  *upstream provider* when it is at capacity, apart from OpenRouter's own caps.
- The docs do not say whether the daily cap is shared across all `:free` models or
  counted per model, or whether failed requests count. *Assume it is shared* until
  a test shows otherwise.
- Data use: OpenRouter has a separate privacy setting for whether free models may
  route to providers that train on your data. Policies are set per provider
  (<https://openrouter.ai/docs/guides/privacy/logging>, 2026-09-24). Check each
  endpoint before sending private code.

`openrouter/free` "analyzes [the request] to determine required capabilities (e.g.
... tool calling ...)", filters the free models to ones that support them, then
**picks one at random**
(<https://openrouter.ai/docs/guides/routing/routers/free-router>, 2026-09-24).

## Candidates

Context, max output and tool support come from the OpenRouter models API
(`/api/v1/models` and `/api/v1/models/{id}/endpoints`, 2026-09-24). Benchmarks come
from each model's own Hugging Face model card, read 2026-09-24. All free OpenRouter
endpoints are served by a single provider.

| # | Model (free route) | Provider · quant · 30-min uptime | Ctx / max out (free endpoint) | Tools | Agentic coding evidence (vendor-reported) |
|---|---|---|---|---|---|
| 1 | `qwen/qwen3.8-27b:free` (also Groq free) | ModelRun · fp4 · 100% | 262,144 / 235,929 (Groq: 131K / 16K) | yes (+ parallel on Groq) | SWE-bench Pro **61.7** (Claude Code harness, 256K ctx); Terminal-Bench 2.1 **73.0** (Terminus); NL2Repo 42.3. Released Aug 2026. [card](https://huggingface.co/Qwen/Qwen3.8-27B) |
| 2 | `poolside/laguna-s-2.1:free` | Poolside · fp4 · 99.99% | 262,144 / 32,768 (native 1M) | yes | Terminal-Bench 2.1 **70.2**; SWE-bench Pro **59.4**; SWE-bench Multilingual 78.5; Toolathlon Verified 49.7. 118B-A8B, released 2026-07-21. Built specifically as a coding agent. [card](https://huggingface.co/poolside/Laguna-S-2.1) |
| 3 | `nex-agi/nex-n2.5-pro:free` | Nex AGI · fp8 · **83.7%, status degraded** | 262,144 / 235,929 | yes | SWE-bench Pro **61.2**; Terminal-Bench 2.1 **82.7**; DeepSWE 1.1 55.8 (NexAU harness). 397B. [card](https://huggingface.co/nex-agi/Nex-N2.5-Pro) |
| 4 | `thinkingmachines/inkling:free` | Thinking Machines · nvfp4 · 99.9% | 1,048,576 / 262,144 | yes (`tool_choice` not listed) | SWE-bench Verified **77.6**; SWE-bench Pro **54.3**; Terminal-Bench 2.1 63.8 ("best harness"). 975B-A41B. [card](https://huggingface.co/thinkingmachines/Inkling) |
| 5 | `nvidia/nemotron-3-ultra-550b-a55b:free` | Nvidia · 98.0% | 1,000,000 / 65,536 | yes | SWE-bench Verified **70.7**; Terminal-Bench 2.1 56.4. Released 2026-06-04. [card](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16) |
| 6 | `nex-agi/nex-n2.5-mini:free` | Nex AGI · bf16 · 99.8% | 262,144 / 235,929 | yes | SWE-bench Pro 43.8; Terminal-Bench 2.1 73.4; DeepSWE 1.1 36.1 (same card as #3) |
| 7 | `poolside/laguna-xs-2.1:free` | Poolside · fp8 · 100% | 262,144 / 32,768 | yes | SWE-bench Verified **70.9**; SWE-bench Pro 47.6; Terminal-Bench **2.0** 37.5 (Harbor, 500 steps). 33B-A3B. [card](https://huggingface.co/poolside/Laguna-XS-2.1) |
| 8 | `cohere/north-mini-code:free` | Cohere · 97.0% | 256,000 / 64,000 | yes | SWE-bench Verified **67.6**, SWE-bench Pro 40.2 (SWE-agent v1.1.0); Terminal-Bench v2 36. 30B-A3B. [card](https://huggingface.co/CohereLabs/North-Mini-Code-1.0) |
| 9 | `openai/gpt-oss-120b` (Groq free only) | Groq | 131,072 / 65,536 | yes, no parallel | SWE-bench Verified 47.9 / 52.6 / **62.4** (low/med/high reasoning); τ-bench Retail 67.8 (high). Released Aug 2025. [model card, arXiv 2508.10925](https://arxiv.org/abs/2508.10925) |
| 10 | `openai/gpt-oss-20b` (Groq free only, **current config**) | Groq | 131,072 / 65,536 | yes, no parallel | SWE-bench Verified 37.4 / 53.2 / **60.7**; τ-bench Retail 54.8 (high). Same source. |

**Excluded** (OpenRouter API, 2026-09-24):

- `z-ai/glm-5.2:free`: its free endpoint does **not** list `tools` and has only 32K context.
- `liquid/lfm-2.5-2.6b:free`: the vendor "advises against using it for agentic coding".
- `inclusionai/ling-3.0-flash-{fin,sante}:free`: tuned for finance and health.
- `nvidia/nemotron-3.5-content-safety:free`: a guardrail model.
- `nvidia/nemotron-3-super-120b-a12b:free`: its card reports no SWE-bench score, only
  Terminal-Bench hard 25.8
  ([card](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-FP8)).
- `stealth/space-bunny-alpha`: anonymous stealth model with unknown provenance and data use.
- Not evaluated (no agentic-coding numbers checked): `google/gemma-4-*:free`,
  `thinkingmachines/inkling-small:free`, `dots-studio/dots-3-note-preview:free`,
  `nvidia/nemotron-3.5-lightning:free`, `nvidia/nemotron-3-nano-omni-*:free`.

### How far to trust these numbers

- Every score is **self-reported by the model's vendor**, each on its own harness:
  Claude Code, Terminus, NexAU, SWE-agent, Harbor, Nemo, or an unnamed "best
  harness". Scores on different harnesses are not directly comparable.
- SWE-bench Verified is easier than SWE-bench Pro, and Terminal-Bench 2.0 is a
  different version from 2.1, so compare like with like. Pro and TB 2.1 are the
  most shared metrics among the top candidates.
- The free endpoints serve quantized weights (fp4/fp8/nvfp4). Vendor scores are
  usually measured at full precision, so free-endpoint quality may be lower.
- Qwen3.8-27B's SWE-bench Pro run used the Claude Code harness, which is the
  closest match to how this repo's Workers will be driven.

## Ranking and realistic Build Ticket size

Sizes used below (defined here; the map may want to adopt or revise them):

- **XS**: 1 file, under ~50 changed lines, fully specified, ≤15 tool calls.
- **S**: 1 to 3 files, under ~150 lines, existing tests to run, ≤40 tool calls.
- **M**: multi-file feature or refactor, new tests, ≤100 tool calls.
- **L**: cross-cutting or design-heavy work. Not for free-tier Workers.

The request budget caps ticket size before model skill does. At 20 RPM, a 40-call S
ticket takes at least 2 minutes of wall time, and a 100-call M ticket at least 5.

| Rank | Model | Largest realistic ticket | Why |
|---|---|---|---|
| 1 | `qwen/qwen3.8-27b:free` (OpenRouter) | **M** (S if still on 50 RPD) | Top SWE-bench Pro score measured on the Claude Code harness; 262K ctx; very large max output; stable endpoint. |
| 2 | `poolside/laguna-s-2.1:free` | **M** | Coding-agent specialist with strong TB 2.1 and Pro scores; stable endpoint. The 32K max output limits large single-file rewrites. |
| 3 | `thinkingmachines/inkling:free` | **M** | Highest SWE-bench Verified; 1M ctx suits larger repos. Missing `tool_choice` may matter to some harnesses. |
| 4 | `nex-agi/nex-n2.5-pro:free` | **M when healthy**, otherwise not viable | Best reported scores, but the endpoint was degraded at 83.7% uptime. Use only as a rotating backup. |
| 5 | `nvidia/nemotron-3-ultra-550b-a55b:free` | **S** | Good SWE-bench Verified; weaker TB 2.1. |
| 6 | `nex-agi/nex-n2.5-mini:free` | **S** | Strong TB 2.1 for its size; weak SWE-bench Pro. |
| 7 | `poolside/laguna-xs-2.1:free` | **S** | Good SWE-bench Verified for 3B active; weak TB 2.0. |
| 8 | `cohere/north-mini-code:free` | **XS–S** | Solid SWE-bench Verified; weaker on Pro and TB. |
| 9 | `openai/gpt-oss-120b` (Groq free) | **XS, single-shot only** | Decent model, but the 8K TPM cap rules out a multi-turn loop. |
| 10 | `openai/gpt-oss-20b` (Groq free) | **XS, single-shot only** | Same TPM cap; weakest model on this list. |
| — | `qwen/qwen3.8-27b` on Groq free | **XS, single-shot only** | Same model as #1, but Groq's 8K TPM and 16K max output apply. Fast (~450 tok/s, Groq model page), so good for Pre-triage. |
| — | `openrouter/free` | **Last-resort fallback only** | Random model on each request; no consistent quality within a session. |

## Implications for this repo's config

These are recommendations for the tickets this issue blocks (#10, #12, #13); nothing
here changes the config.

1. Point the Worker tier at `openrouter/qwen/qwen3.8-27b:free`, with
   `openrouter/poolside/laguna-s-2.1:free` and `openrouter/thinkingmachines/inkling:free`
   as fallbacks, before falling back to `openrouter/openrouter/free`.
2. Move Groq (`gpt-oss-20b`/`120b`, `qwen3.8-27b`) to Pre-triage and single-shot
   duty, and keep each prompt under 8K tokens.
3. Buy the one-time $10 of OpenRouter credit. It raises the cap from 50 to 1,000
   free requests a day.
4. Send `x-ratelimit-*` (Groq) and `Retry-After` (both providers) into the Gateway's
   backoff, so a 429 waits instead of dropping straight to a weaker model.
5. Before settling the ranking, run a bake-off: the same 3 to 5 real Build Tickets
   on the top three models through the actual Worker harness.

## Open questions

- Does OpenRouter count the free daily cap per account or per model, and do failed
  requests count?
- How does Groq respond to one request larger than 8K TPM (413 or 429)? This needs
  a quick live test.
- How much do quantized free endpoints lose compared with the vendor scores?
  Only the bake-off can answer this.
