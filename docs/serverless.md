# Serverless harness (Netlify or Vercel)

A second, smaller way to run the harness: Node serverless functions that send OpenAI-format chat requests straight to OpenRouter. There is no LiteLLM Gateway, no Python Router and no database. The LiteLLM stack (`server.js`, `config.yaml`, `router.py`) keeps working unchanged alongside it. Back to the [README](../README.md) · [Architecture](../ARCHITECTURE.md).

## Design

- **One handler, two adapters.** `serverless/core.mjs` takes a Web `Request` and returns a `Response`. `netlify/functions/v1.mjs` (Netlify Functions) and `api/v1/[...path].mjs` (Vercel Edge runtime) only call it. Tests call it directly with a fake `fetch`.
- **Routes:** `POST /v1/chat/completions`, `GET /v1/models`, `GET /healthz`. Vercel rewrites `/v1/*` to `/api/v1/*`; the handler removes that `/api` prefix.
- **Upstream:** `POST {OPENROUTER_URL}/chat/completions` with `OPENROUTER_API_KEY`. The body is passed on unchanged except for `model`. The reply, including a stream, is passed back as it arrives.
- **Access:** every `/v1` call needs `SERVERLESS_API_KEY` (as `Authorization: Bearer` or `x-api-key`). If either key is unset the deployment answers 503 and sends nothing upstream, so it cannot become an open proxy that spends your credit.
- **Model choice** (no Jev, no Router). In order:
  1. `x-harness-model` header. It must be in the allowed list or the call gets 400.
  2. The request's `model` field, if it is in the allowed list.
  3. `x-harness-tier: strong` or `weak`.
  4. Rules: a request with `tools`, or with more than `HARNESS_STRONG_CHARS` (default 8000) characters of message text, goes to the strong model. Everything else goes to the weak model.
  
  Every reply carries `x-harness-model` and `x-harness-route` (`pinned`, `requested`, `tier`, `tools`, `long`, `short`).
- **Transforms** (same as the Interceptor, `serverless/transforms.mjs`), in the Interceptor's order:
  1. **caveman**: the terse-output line is added to the system prompt (`utils/messageTransforms.js`).
  2. **Context anchor**: a tool result identical to an earlier one becomes a pointer to the first copy.
  3. **Headroom**: long tool results are shortened from the middle (the in-repo rule the Docker stack uses).
  4. **Headroom service** (optional): the `headroom-ai` TypeScript client (`HeadroomClient`) sends the tool results to a `headroom proxy` at `HEADROOM_URL` for real compression. If the URL is unset or the proxy does not answer, the request goes on after step 3.

  User text is never changed. Each reply lists the transforms it used in `x-harness-transforms`.
- **Limits:** request bodies over `HARNESS_MAX_BYTES` (default 1 MB) get 413. OpenRouter has `HARNESS_TIMEOUT_MS` (default 25 s) to start answering, otherwise 504; a stream is not cut after that. A network failure to OpenRouter is 502. OpenRouter's own error statuses (429, 402, and so on) are returned as they came.

What this does **not** do yet: the chat web pages, usage logs, per-person logins, MCP tools, the task runner, and the Anthropic `/v1/messages` format. Those live in the Interceptor and stay on the LiteLLM stack. Claude Code and other Anthropic-format clients should keep using the LiteLLM stack until an Anthropic route is added here.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `OPENROUTER_API_KEY` | (required) | Your OpenRouter key |
| `SERVERLESS_API_KEY` | (required) | The key your clients send. Make it long and random |
| `HARNESS_STRONG_MODEL` | `anthropic/claude-sonnet-5.5` | Model for tools and long conversations |
| `HARNESS_WEAK_MODEL` | `anthropic/claude-haiku-5.5` | Everything else |
| `HARNESS_MODELS` | (empty) | Extra models a client may ask for by name, comma-separated |
| `HARNESS_STRONG_CHARS` | `8000` | Length that counts as long |
| `HARNESS_TIMEOUT_MS` | `25000` | Wait for OpenRouter to start answering |
| `HARNESS_MAX_BYTES` | `1000000` | Largest request body |
| `HARNESS_CAVEMAN`, `HARNESS_CONTEXT_ANCHOR`, `HARNESS_HEADROOM` | on | Set `0` to turn a transform off (the Settings page in the Docker stack) |
| `HEADROOM_URL` | (empty) | Address of a `headroom proxy` (`pip install "headroom-ai[proxy]"`, run `headroom proxy`). Empty means no Headroom service |
| `HEADROOM_TIMEOUT_MS` | `5000` | How long the Headroom service may take before the request goes on uncompressed |
| `HARNESS_SITE_URL`, `HARNESS_SITE_NAME` | (empty), `Custom AI Harness` | Sent to OpenRouter as `HTTP-Referer` and `X-Title` |
| `OPENROUTER_URL` | `https://openrouter.ai/api/v1` | Only to point at another OpenRouter-compatible base |

Set them in the Netlify or Vercel dashboard (Site settings → Environment variables, or Project settings → Environment Variables). Never commit them.

## Deploy

**Netlify:** connect the repository. `netlify.toml` sets the publish folder to `serverless/public` (a short landing page) and the functions folder to `netlify/functions`. Set the variables above, then deploy. The API is at `https://<site>/v1/chat/completions`.

**Vercel:** import the repository as a project with no build step. `vercel.json` rewrites `/v1/*` and `/healthz` to the Edge function in `api/v1/`. Set the variables above, then deploy.

Point a client at the base URL with the key:

```bash
curl https://<your-site>/v1/chat/completions \
  -H "Authorization: Bearer $SERVERLESS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Say hi"}]}' -i
```

## Limits to know

- The adapters are **not yet run against a live Netlify or Vercel deployment.** The tests cover the handler and check the adapters' exports; the platform wiring (Netlify `config.path`, Vercel rewrites and the Edge runtime) needs one real deploy to confirm.
- Platform time limits apply on top of `HARNESS_TIMEOUT_MS`. Long answers stream, but a stream that runs past the platform's maximum duration is cut by the platform.
- Each request is independent: there is no usage log, no per-person spending cap and no rate limit. Set a spending limit on the OpenRouter key.
- The Headroom service needs a server. Netlify and Vercel cannot run the Python `headroom proxy`, so run it somewhere reachable (a small VM, or the Fly machine) and set `HEADROOM_URL`. Without it only the in-repo transforms run, which is what the Docker stack does for chat.
- The `headroom-ai` package is also the name of the Python package. Its npm version (0.42.0) is the same project and matches the Python one; this repo uses only its TypeScript client.
- The heuristic is not a classifier. For a smart route, use the LiteLLM stack with the Router.

## Tests

`test/serverless.test.js` (`node --test test/serverless.test.js`) covers access, model choice, transforms, streaming, limits, upstream errors and both adapters, with a fake OpenRouter and a fake Headroom client.
