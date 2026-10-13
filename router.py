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

The Router only classifies. The Interceptor sends the request to the Gateway
itself, so the Router never has to understand OpenAI or Anthropic request
formats (RouteLLM's own proxy server rejects tool schemas and needs an OpenAI
key even for BERT).

Run: python router.py [--config routellm-config.yaml] [--port 6060]
"""
import argparse
import importlib
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


def load_config(path: str) -> None:
    """Read the YAML config and build the configured backend's scorer."""
    global scorer, config_path, last_error
    with open(path, encoding="utf-8") as f:
        new_config = yaml.safe_load(f)
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
            "config": config_path, "last_error": last_error}


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
    args = parser.parse_args()
    load_config(args.config)
    uvicorn.run(app, host="127.0.0.1", port=args.port)
