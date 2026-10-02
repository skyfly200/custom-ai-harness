"""Router: classifies a prompt as strong or weak with a local classifier.

Two interchangeable backends (config key `backend`):
  routellm (default) - RouteLLM's BERT checkpoint
  laya               - Laya (https://github.com/NandhaKishorM/laya), a
                       non-autoregressive typed-decision model; asks one yes/no
                       question ("is this hard?") and uses its probability as
                       the strong win rate. Multilingual via laya's own Router.

    POST /route {"prompt": str, "threshold": float, "tokens": int}
      -> {"model": str, "win_rate": float}

The Router only classifies. The Interceptor sends the request to the Gateway
itself, so the Router never has to understand OpenAI or Anthropic request
formats (RouteLLM's own proxy server rejects tool schemas and needs an OpenAI
key even for BERT).

Run: python router.py [--config routellm-config.yaml] [--port 6060]
"""
import argparse
import os

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

    scorer = BACKENDS[config.get("backend", "routellm")](config)
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


BACKENDS = {"routellm": make_routellm_scorer, "laya": make_laya_scorer}


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

    with open(args.config, encoding="utf-8") as f:
        config.update(yaml.safe_load(f))
    scorer = BACKENDS[config.get("backend", "routellm")](config)
    uvicorn.run(app, host="127.0.0.1", port=args.port)
