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

The Router only classifies. The Interceptor sends the request to the Gateway
itself, so the Router never has to understand OpenAI or Anthropic request
formats (RouteLLM's own proxy server rejects tool schemas and needs an OpenAI
key even for BERT).

Run: python router.py [--config routellm-config.yaml] [--port 6060]
"""
import argparse
import importlib
import os
import re

# RouteLLM builds an OpenAI client at import time for routers we never use.
os.environ.setdefault("OPENAI_API_KEY", "unused-local-bert-router")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import yaml
from fastapi import FastAPI
from pydantic import BaseModel, Field

config = {}
scorer = None  # callable: prompt -> strong win rate in [0, 1]
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


def _headers(config: dict) -> dict:
    key = os.environ.get(config.get("api_key_env", ""), "") if config.get("api_key_env") else ""
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


def pick_model(win_rate: float, threshold: float, tokens: int, config: dict) -> str:
    # RouteLLM rule: strong model when the strong model's win rate >= threshold
    if win_rate >= threshold:
        return config["strong_model"]
    # The weak model's provider may cap request size (Groq free tier: 8K tokens/min)
    limit = config.get("weak_model_max_tokens")
    if limit and tokens > limit:
        return config["weak_model_overflow"]
    return config["weak_model"]


def load_config(path: str) -> None:
    """Read the YAML config and build the configured backend's scorer."""
    global scorer
    with open(path, encoding="utf-8") as f:
        config.clear()
        config.update(yaml.safe_load(f))
    scorer = BACKENDS[config.get("backend", "routellm")](config)


@app.post("/route")
def route(req: RouteRequest):
    win_rate = scorer(req.prompt)
    return {"model": pick_model(win_rate, req.threshold, req.tokens, config), "win_rate": round(win_rate, 3)}


@app.get("/health")
def health():
    return {"status": "ok", "backend": config.get("backend", "routellm")}


if __name__ == "__main__":
    import uvicorn
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="routellm-config.yaml")
    parser.add_argument("--port", type=int, default=6060)
    args = parser.parse_args()
    load_config(args.config)
    uvicorn.run(app, host="127.0.0.1", port=args.port)
