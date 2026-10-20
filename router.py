"""Router: classifies a prompt as strong or weak with a local classifier.

Interchangeable backends (config key `backend`); each turns a prompt into the
strong model's win rate in [0, 1]:
  routellm (default) - RouteLLM's BERT checkpoint
  laya               - Laya (https://github.com/NandhaKishorM/laya) in-process;
                       one yes/no question ("needs a strong model?"), its
                       probability is the win rate
  systemone          - any server speaking the Jev /v1/systemone protocol:
                       TypeSafe's hosted Jev, or `laya-serve`
                       (launch-laya.sh)
  llm                - any OpenAI-compatible chat endpoint (a reasoning model
                       asked to rate difficulty 0-1)
  custom             - `scorer: "package.module:factory"`; factory(config)
                       returns a callable prompt -> float

    POST /route {"prompt": str, "threshold": float, "tokens": int}
      -> {"model": str, "win_rate": float}
    POST /admin/reload               re-read the config file
    POST /admin/backend {"backend"}  switch classifier until the next reload
    POST /admin/config {"changes"}   change settings until the next reload
    POST /admin/save                 write the running settings to the config file

The Router only classifies. The Interceptor sends the request to the Gateway
itself, so the Router never has to understand OpenAI or Anthropic request
formats (RouteLLM's own proxy server rejects tool schemas and needs an OpenAI
key even for BERT).

Run: python router.py [--config routellm-config.yaml] [--port 6060] [--host 127.0.0.1]
"""
import argparse
import importlib
import json
import logging
import os
import re

# RouteLLM builds an OpenAI client at import time for routers we never use.
os.environ.setdefault("OPENAI_API_KEY", "unused-local-bert-router")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import yaml
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

config = {}
config_path = None  # file load_config read, for /admin/reload
scorer = None  # callable: prompt -> strong win rate in [0, 1]
last_error = None  # most recent classifier failure, shown on /health
app = FastAPI()

LAYA_QUESTION = {
    "hard": {
        "type": "noul",
        "instructions": "Does this coding request need a strong model: multi-file changes, "
                        "architecture, refactoring, or debugging a subtle bug, rather than "
                        "a small edit, a simple question or an explanation?",
    }
}


def make_routellm_scorer(config: dict):
    from routellm.routers.routers import BERTRouter

    bert = BERTRouter(checkpoint_path=config["checkpoint"])
    return lambda prompt: float(bert.calculate_strong_win_rate(prompt))


def make_laya_scorer(config: dict):
    from laya import Router as LayaRouter

    laya = LayaRouter(preload=bool(config.get("laya_preload", False)))
    max_chars = int(config.get("laya_max_chars", 2000))  # encoder context is 512-1024 tokens
    questions = {"hard": {**LAYA_QUESTION["hard"]}}

    def score(prompt: str) -> float:
        # Keep the tail: the end of a long prompt is the actual ask.
        result = laya.predict(prompt[-max_chars:], questions)
        return float(result["answers"]["hard"]["noul"])  # P(yes) = needs strong

    return score


log = logging.getLogger("router")


def _headers(config: dict) -> dict:
    key = os.environ.get(config.get("api_key_env", ""), "") if config.get("api_key_env") else ""
    if config.get("api_key_env") and not key:
        log.warning("%s is not set (in the shell or .env); calling %s without a key",
                    config["api_key_env"], config.get("base_url"))
    return {config.get("auth_header", "Authorization"): f"Bearer {key}"} if key else {}


def make_systemone_scorer(config: dict):
    """Jev (TypeSafe) or laya-serve: POST {base_url}/v1/systemone."""
    import httpx

    url = config["base_url"].rstrip("/") + "/v1/systemone"
    timeout = float(config.get("timeout", 10))
    client = httpx.Client(headers=_headers(config), timeout=timeout)
    extra = {"model": config["model"]} if config.get("model") else {}
    max_chars = int(config.get("max_chars", 2000))

    def score(prompt: str) -> float:
        body = {"state": {"body": prompt[-max_chars:]}, "questions": LAYA_QUESTION, **extra}
        res = client.post(url, json=body)
        res.raise_for_status()
        return float(res.json()["answers"]["hard"]["noul"])

    return score


LLM_SYSTEM = ("You rate how hard a coding request is for an AI model. Reply with only a number "
              "from 0 (trivial: small edit, simple question, explanation) to 1 (very hard: "
              "multi-file change, architecture, refactor, subtle bug).")


def parse_score(text: str) -> float:
    """Last number in the reply, after dropping any <think> block; clamped to [0, 1]."""
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)
    nums = re.findall(r"\d*\.?\d+", text)
    if not nums:
        raise ValueError(f"no score in model reply: {text[:80]!r}")
    return min(1.0, max(0.0, float(nums[-1])))


def make_llm_scorer(config: dict):
    """Any OpenAI-compatible /chat/completions endpoint, e.g. a reasoning model."""
    import httpx

    url = config["base_url"].rstrip("/") + "/chat/completions"
    client = httpx.Client(headers=_headers(config), timeout=float(config.get("timeout", 30)))
    max_chars = int(config.get("max_chars", 4000))

    def score(prompt: str) -> float:
        res = client.post(url, json={
            "model": config["model"],
            "max_tokens": int(config.get("max_tokens", 2048)),  # headroom for reasoning tokens
            "messages": [{"role": "system", "content": LLM_SYSTEM},
                         {"role": "user", "content": prompt[-max_chars:]}],
        })
        res.raise_for_status()
        return parse_score(res.json()["choices"][0]["message"]["content"] or "")

    return score


def make_custom_scorer(config: dict):
    module, _, name = config["scorer"].partition(":")
    return getattr(importlib.import_module(module), name)(config)


BACKENDS = {
    "routellm": make_routellm_scorer,
    "laya": make_laya_scorer,
    "systemone": make_systemone_scorer,
    "llm": make_llm_scorer,
    "custom": make_custom_scorer,
}


class RouteRequest(BaseModel):
    prompt: str
    threshold: float = Field(ge=0.0, le=1.0)
    tokens: int = 0  # Interceptor's estimate of input + requested output tokens
    tools: bool = False  # the request carries tool definitions (every Claude Code request does)


def pick_model(win_rate: float, threshold: float, tokens: int, config: dict, tools: bool = False) -> str:
    # RouteLLM rule: strong model when the strong model's win rate >= threshold
    if win_rate >= threshold:
        return config["strong_model"]
    # A weak model that can't call tools answers a tool request with text instead of tool calls
    if tools and config.get("weak_model_tools"):
        return config["weak_model_tools"]
    # The weak model's provider may cap request size (Groq free tier: 8K tokens/min)
    limit = config.get("weak_model_max_tokens")
    if limit and tokens > limit:
        return config["weak_model_overflow"]
    return config["weak_model"]


# Launch settings for Docker (see .env.example). HARNESS_MODE picks a classifier
# preset; the variables in ENV_KEYS set single keys. Both win over the config
# file on every load, so unset them to manage the Router from the dashboard.
MODE_PRESETS = {
    "jev": {"backend": "systemone", "base_url": "https://openrouter.ai/api",
            "api_key_env": "OPENROUTER_API_KEY", "model": "jev-latest"},
    "laya": {"backend": "laya"},
    "routellm": {"backend": "routellm"},
    # a chat model rates difficulty; under the Interceptor's 10 s wait on the Router
    "llm": {"backend": "llm", "base_url": "https://openrouter.ai/api/v1",
            "api_key_env": "OPENROUTER_API_KEY", "model": "openai/gpt-4o-mini", "timeout": 9},
}
ENV_KEYS = {
    "ROUTER_BACKEND": "backend", "ROUTER_BASE_URL": "base_url", "ROUTER_MODEL": "model",
    "ROUTER_API_KEY_ENV": "api_key_env", "ROUTER_TIMEOUT": "timeout",
    "STRONG_MODEL": "strong_model", "WEAK_MODEL": "weak_model",
    "WEAK_MODEL_TOOLS": "weak_model_tools", "WEAK_MODEL_OVERFLOW": "weak_model_overflow",
}


def env_overrides(environ) -> dict:
    """Config keys set by HARNESS_MODE and the ENV_KEYS variables; empty when none are set."""
    mode = environ.get("HARNESS_MODE", "").strip().lower()
    if mode and mode not in MODE_PRESETS and mode != "passthrough":  # passthrough skips the Router
        log.warning("HARNESS_MODE=%s isn't one of %s; using the config file", mode, ", ".join(MODE_PRESETS))
    out = dict(MODE_PRESETS.get(mode, {}))
    for var, key in ENV_KEYS.items():
        value = environ.get(var, "").strip()
        if value:
            out[key] = float(value) if key == "timeout" else value
    return out


def load_config(path: str) -> None:
    """Read the YAML config and build the configured backend's scorer."""
    global scorer, config_path, last_error
    with open(path, encoding="utf-8") as f:
        new_config = yaml.safe_load(f)
    overrides = env_overrides(os.environ)
    if overrides:
        log.info("settings from the environment: %s", overrides)
        new_config.update(overrides)
    for key in MODEL_KEYS & new_config.keys():
        new_config[key] = RENAMED.get(new_config[key], new_config[key])
    # Build the scorer before swapping, so a bad file leaves the running config in place
    new_scorer = BACKENDS[new_config.get("backend", "routellm")](new_config)
    config.clear()
    config.update(new_config)
    scorer, config_path, last_error = new_scorer, path, None


@app.post("/route")
def route(req: RouteRequest):
    try:
        win_rate = scorer(req.prompt)
    except Exception as err:
        # One readable line instead of an ASGI traceback; the Interceptor falls back on any non-200.
        global last_error
        detail = describe_error(err)
        last_error = detail
        log.error("classifier (%s) failed: %s", config.get("backend", "routellm"), detail)
        return JSONResponse(status_code=502, content={"error": detail})
    return {"model": pick_model(win_rate, req.threshold, req.tokens, config, req.tools), "win_rate": round(win_rate, 3)}


def describe_error(err: Exception) -> str:
    """The upstream status and body for an HTTP error, else the exception type and message."""
    response = getattr(err, "response", None)
    if response is not None and getattr(err, "request", None) is not None:
        return f"HTTP {response.status_code} from {err.request.url}: {response.text[:300]}"
    return f"{type(err).__name__}: {err}"


@app.get("/health")
def health():
    return {"status": "ok", "backend": config.get("backend", "routellm"), "backends": list(BACKENDS),
            "config": config_path, "last_error": last_error,
            "settings": {k: v for k, v in config.items() if k in EDITABLE}}


class BackendRequest(BaseModel):
    backend: str


@app.post("/admin/backend")
def switch_backend(req: BackendRequest):
    """Use another classifier with the current config's settings, until the next reload."""
    global scorer, last_error
    if req.backend not in BACKENDS:
        return JSONResponse(status_code=400, content={"error": f"unknown backend {req.backend!r}"})
    new_config = {**config, "backend": req.backend}
    try:
        new_scorer = BACKENDS[req.backend](new_config)
    except KeyError as err:
        # e.g. llm without base_url in the config file
        return JSONResponse(status_code=400, content={"error": f"{req.backend} needs {err} in the config file"})
    except Exception as err:
        # e.g. laya not installed
        return JSONResponse(status_code=400, content={"error": describe_error(err)})
    config["backend"] = req.backend
    scorer, last_error = new_scorer, None
    return health()


# Settings the control UI may change, each with its type. The model names only
# affect pick_model; the rest build the scorer, so changing them rebuilds it.
EDITABLE = {
    "strong_model": str, "weak_model": str, "weak_model_tools": str, "weak_model_overflow": str,
    "weak_model_max_tokens": int,
    "backend": str, "checkpoint": str, "base_url": str, "model": str, "api_key_env": str,
    "auth_header": str, "timeout": float, "max_chars": int, "max_tokens": int,
    "laya_max_chars": int, "laya_preload": bool, "scorer": str,
}
# Old Gateway names for the local engine, which config.yaml once named after a
# Claude model it never was; a config that still uses them reaches local-engine.
RENAMED = {"claude-sonnet-5": "local-engine", "claude-3-5-sonnet": "local-engine"}
MODEL_KEYS = {"strong_model", "weak_model", "weak_model_tools", "weak_model_overflow", "weak_model_max_tokens"}
REQUIRED = {"strong_model", "weak_model", "backend"}


class ConfigRequest(BaseModel):
    changes: dict  # key -> new value; null or "" removes an optional key


def apply_changes(current: dict, changes: dict) -> dict:
    new_config = dict(current)
    for key, value in changes.items():
        if key not in EDITABLE:
            raise ValueError(f"{key} can't be changed here")
        if value is None or value == "":
            if key in REQUIRED:
                raise ValueError(f"{key} can't be empty")
            new_config.pop(key, None)
            continue
        kind = EDITABLE[key]
        if kind is bool and not isinstance(value, bool):
            raise ValueError(f"{key} must be true or false")
        try:
            new_config[key] = kind(value)
        except (TypeError, ValueError):
            raise ValueError(f"{key} must be a {kind.__name__}")
    if new_config.get("backend") not in BACKENDS:
        raise ValueError(f"unknown backend {new_config.get('backend')!r}")
    return new_config


@app.post("/admin/config")
def change_config(req: ConfigRequest):
    """Change settings until the next reload; the scorer is rebuilt only when a classifier setting changed."""
    global scorer, last_error
    try:
        new_config = apply_changes(config, req.changes)
        new_scorer = scorer
        if set(req.changes) - MODEL_KEYS:
            new_scorer = BACKENDS[new_config["backend"]](new_config)
    except KeyError as err:
        return JSONResponse(status_code=400, content={"error": f"{config.get('backend')} needs {err} in the config"})
    except Exception as err:
        return JSONResponse(status_code=400, content={"error": describe_error(err)})
    config.clear()
    config.update(new_config)
    if new_scorer is not scorer:
        scorer, last_error = new_scorer, None
    return health()


def yaml_scalar(value) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value)
    plain = re.fullmatch(r"[\w./:@-]+", text) and yaml.safe_load(text) == text
    return text if plain else json.dumps(text)


def write_settings(text: str, settings: dict) -> str:
    """Set each editable key in the YAML text, keeping comments and layout.
    A key that is no longer set is commented out; a new one is appended."""
    lines = text.splitlines()
    for key in EDITABLE:
        pattern = re.compile(rf"^{re.escape(key)}:(\s*)([^#\n]*?)(\s*#.*)?$")
        index = next((i for i, line in enumerate(lines) if pattern.match(line)), None)
        if key in settings:
            if index is None:
                lines.append(f"{key}: {yaml_scalar(settings[key])}")
            else:
                m = pattern.match(lines[index])
                comment = m.group(3) or ""
                lines[index] = f"{key}: {yaml_scalar(settings[key])}{comment}"
        elif index is not None:
            lines[index] = "# " + lines[index]
    return "\n".join(lines) + "\n"


@app.post("/admin/save")
def save_config():
    if not config_path:
        return JSONResponse(status_code=400, content={"error": "no config file loaded"})
    with open(config_path, encoding="utf-8") as f:
        text = f.read()
    updated = write_settings(text, config)
    # Check the edit reads back as the running settings before touching the file
    editable = lambda c: {k: v for k, v in (c or {}).items() if k in EDITABLE}
    if editable(yaml.safe_load(updated)) != editable(config):
        return JSONResponse(status_code=500, content={"error": "couldn't write the settings without changing others; edit the file by hand"})
    with open(config_path, "w", encoding="utf-8") as f:
        f.write(updated)
    return health()


@app.post("/admin/reload")
def reload_config():
    if not config_path:
        return JSONResponse(status_code=400, content={"error": "no config file loaded"})
    try:
        load_config(config_path)
    except Exception as err:
        return JSONResponse(status_code=400, content={"error": describe_error(err)})
    return health()


def load_dotenv(path: str = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")) -> None:
    """Fill unset variables from .env, the file the Interceptor reads, so API keys live in one place."""
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                key, sep, value = line.strip().partition("=")
                if sep and key and not key.startswith("#"):
                    os.environ.setdefault(key.strip(), value.strip().strip("'\""))
    except FileNotFoundError:
        pass


if __name__ == "__main__":
    import uvicorn
    load_dotenv()
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="routellm-config.yaml")
    parser.add_argument("--port", type=int, default=6060)
    # Docker sets 0.0.0.0 so the Interceptor's container can reach it
    parser.add_argument("--host", default=os.environ.get("ROUTER_HOST", "127.0.0.1"))
    args = parser.parse_args()
    load_config(args.config)
    uvicorn.run(app, host=args.host, port=args.port)
