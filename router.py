"""Router: classifies a prompt as strong or weak with RouteLLM's local BERT model.

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
bert = None
app = FastAPI()


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
    win_rate = float(bert.calculate_strong_win_rate(req.prompt))
    return {"model": pick_model(win_rate, req.threshold, req.tokens, config), "win_rate": round(win_rate, 3)}


@app.get("/health")
def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    from routellm.routers.routers import BERTRouter

    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="routellm-config.yaml")
    parser.add_argument("--port", type=int, default=6060)
    args = parser.parse_args()

    with open(args.config, encoding="utf-8") as f:
        config.update(yaml.safe_load(f))
    bert = BERTRouter(checkpoint_path=config["checkpoint"])
    uvicorn.run(app, host="127.0.0.1", port=args.port)
