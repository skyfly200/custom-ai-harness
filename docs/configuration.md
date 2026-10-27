# Configuration

Environment variables, `config.yaml`, `routellm-config.yaml` and the Router classifier. Back to the [README](../README.md).

## Configuration

### Environment variables

API keys are loaded from `.env` automatically when `npm start` runs. Copy the template and fill in your values:

```
GROQ_API_KEY=your_groq_key
OPENROUTER_API_KEY=your_openrouter_key
ANTHROPIC_API_KEY=your_anthropic_key   # optional
```

`HARNESS_PASSWORD` is optional on your own PC and required by the Docker setup. When set, every page and API asks for it: browsers show a login box (any user name), and agents send it as their API key (`Authorization: Bearer`, `x-api-key`) or in an `x-harness-password` header. The harness doesn't pass it on to the Gateway. It also lets the Settings page's controls work from other machines, which otherwise answer only on the machine the harness runs on.


`ARTIFICIAL_ANALYSIS_API_KEY` is optional: a free key from [Artificial Analysis](https://artificialanalysis.ai/) fills in each model's quality, coding and speed numbers on the Routing page (fetched once a day).

`LITELLM_MASTER_KEY` is optional. Set it to require a key on the Gateway and to log in to LiteLLM's admin UI at http://localhost:4000/ui (username `admin`, the key as the password). LiteLLM reads it from `.env` too, as long as LiteLLM is installed in this repo's `.venv` as shown above (LiteLLM looks for `.env` in the folders above its own install, not the folder you start it from). If LiteLLM is installed somewhere else, set the variable in the shell before starting it. The harness then sends the master key on every call it forwards to LiteLLM, so clients such as Claude Code keep working with whatever key they already use. Generate one with:

```bash
python -c "import secrets; print('sk-' + secrets.token_urlsafe(32))"
```

The Docker launch settings (`HARNESS_MODE`, `STRONG_MODEL`, `PASSTHROUGH_MODEL`, `LOCAL_MODELS`, ...) are described in [Choose how it works](server-docker.md#choose-how-it-works) and `.env.example`. `router.py` and the Interceptor read them outside Docker too (except passthrough, which needs the Docker Gateway): `HARNESS_MODE`, `ROUTER_*`, `STRONG_MODEL` and the `WEAK_MODEL*` variables override `routellm-config.yaml`; `PIN_MODEL`, `HARNESS_TRANSFORMS=on|off` and `ROUTER_DOWN_MODEL`/`ROUTER_DOWN_TOOLS_MODEL` override the Settings page. `docker/gateway-start.py` applies `PASSTHROUGH_*`, `LOCAL_MODELS`, `OLLAMA_URL` and `LOCAL_ENGINE_URL` to a copy of `config.yaml` when the Gateway container starts.

Keys can also be set in the shell session if preferred:

**macOS / Linux**
```bash
export GROQ_API_KEY=your_groq_key
export OPENROUTER_API_KEY=your_openrouter_key
```

**Windows (PowerShell)**
```powershell
$env:GROQ_API_KEY = "your_groq_key"
$env:OPENROUTER_API_KEY = "your_openrouter_key"
```

### `config.yaml`

Defines the LiteLLM model list and fallback chain. The fallback order for every strong-model request is:

```
local-engine → fast-openrouter (GPT-4o mini, paid) → fallback-openrouter-tools (Nemotron 3.5 Super VL, free) → fallback-openrouter (Xing 4.0, free) → fallback-groq (GPT-OSS 120B)
```

`local-engine` is your own llama.cpp or vLLM server on port 8000 (`launch-local.sh`), running whichever model you loaded. It used to be called `claude-sonnet-5` and `claude-3-5-sonnet`, though it was never a Claude model; saved strategies, settings and Router configs that still use those names reach `local-engine`.

The OpenRouter backups are named free models, not `openrouter/free`. That one picks a free model at random for each request, and its pool includes NVIDIA's content-safety classifier, which answers "User Safety: safe / Response Safety: ..." instead of replying. Free models come and go on OpenRouter (Llama 3.3 70B `:free` lost its last provider in October 2026), so if a backup starts failing every call, pick another in the routing page's **Add model** list with the **Free** filter.

LiteLLM gives each model `request_timeout` (120 s) before it moves to the next one, and `router_settings.num_retries: 0` makes it move on at once after a rate limit instead of waiting to retry a spent quota.

Deprecated Llama 3/3.1 variants are intentionally absent. Groq serves GPT-OSS 120B: its free tier gives it the same limits as the 20B (8K tokens/min, 1K requests/day), so the bigger model costs nothing extra.

Each deployment sets `max_parallel_requests` (local engine 1, Groq 3, OpenRouter 5), so bursts queue in the Gateway instead of tripping provider rate limits.

### `routellm-config.yaml`

Configures `router.py`: the local RouteLLM `bert` checkpoint (no external embedding API key needed) and the Gateway model names it picks between. The Router only classifies; the Interceptor then sends the request to the Gateway on port 4000 itself.

RouteLLM's bundled `openai_server` is not used: it rejects tool schemas, can't carry the Anthropic format, and needs an `OPENAI_API_KEY` even for BERT.

#### Choosing a classifier: `backend:`

Every backend turns the prompt into the strong model's win rate in [0, 1]; the threshold and overflow rules are the same for all of them. Set one in `routellm-config.yaml` (the file has a commented block for each):

| `backend:` | What scores the prompt | Keys it reads | Install |
|---|---|---|---|
| `routellm` (default) | RouteLLM BERT, in-process | `checkpoint` | `pip install routellm` |
| `laya` | [Laya](https://github.com/NandhaKishorM/laya), in-process: P(yes) for "does this need a strong model?" | `laya_max_chars` (2000), `laya_preload` (false) | `pip install -r requirements-laya.txt` |
| `systemone` | A server speaking the Jev `POST /v1/systemone` protocol: TypeSafe Jev, or a local `laya-serve` | `base_url`, `api_key_env`, `auth_header` (Authorization), `model`, `max_chars` (2000), `timeout` (10) | `pip install httpx` |
| `llm` | Any OpenAI-compatible `/chat/completions` model asked to rate difficulty 0 to 1; `<think>` blocks are ignored | `base_url`, `model`, `api_key_env`, `max_tokens` (2048), `max_chars` (4000), `timeout` (30) | `pip install httpx` |
| `custom` | Your `factory(config)` returning `prompt -> float` | `scorer: "package.module:factory"` | |

`api_key_env` names the environment variable holding the key, so the key itself never goes in the file. For example, Jev:

```yaml
backend: systemone
base_url: https://openrouter.ai/api   # Jev via OpenRouter, or http://localhost:8001 for laya-serve (launch-laya.sh)
api_key_env: OPENROUTER_API_KEY
model: jev-latest
```

`GET /health` on the Router reports which backend is running.

#### Router classifier: Jev through OpenRouter

`routellm-config.yaml` points the Router at TypeSafe's [Jev on OpenRouter](https://openrouter.ai/typesafe) (`backend: systemone`, `base_url: https://openrouter.ai/api`), which answers "does this request need a strong model?" with nothing to run locally. It uses the same `OPENROUTER_API_KEY` as the Gateway; the Router reads it from `.env` like the Interceptor does. Jev bills per input token, and the Router sends at most the last 2,000 characters of each request (`max_chars`).

If Jev errors or takes longer than `timeout` (5 s), the Router returns an error and the Interceptor sends the request to `fallback-openrouter`. To go back to the BERT classifier, set `backend: routellm`.

#### Running Laya locally (optional)

[Laya](https://github.com/NandhaKishorM/laya) is an open-source classifier that speaks the same protocol as Jev, so it can replace Jev with no API key or per-token cost. It runs on CPU.

1. Start the server on port 8001 (the Tier 1 local engine already uses 8000).

   **macOS / Linux**
   ```bash
   source .venv/bin/activate
   ./launch-laya.sh            # installs laya[serve] with CPU PyTorch on first run
   ./launch-laya.sh docker     # or: Laya's own CPU Docker image
   ```

   **Windows (PowerShell)**
   ```powershell
   .\.venv\Scripts\Activate.ps1
   pip install --index-url https://download.pytorch.org/whl/cpu torch
   pip install "laya[serve]"
   $env:LAYA_HOST = "127.0.0.1"; $env:LAYA_PORT = "8001"; $env:LAYA_DEVICE = "cpu"
   $env:LAYA_MODELS = "english"; $env:LAYA_PRELOAD = "1"
   laya-serve
   ```

   The first start downloads the English checkpoint from Hugging Face.

2. Wait until `curl http://127.0.0.1:8001/health` answers.

3. In `routellm-config.yaml`, set `base_url: http://127.0.0.1:8001` and comment out `api_key_env` and `model` (Laya rejects model names it does not serve).

4. Restart the Router. `GET http://localhost:6060/health` still reports `systemone`; the Router log shows connection errors if Laya is not running.

To run Laya on another machine, start it there with `LAYA_HOST=0.0.0.0 LAYA_API_KEY=<secret> ./launch-laya.sh`, set `base_url` to that machine, and set `api_key_env: LAYA_API_KEY` with the same key in `.env`.
