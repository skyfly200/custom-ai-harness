"""Router: classifies a prompt as strong or weak with RouteLLM's local BERT model.

    POST /route {"prompt": str, "threshold": float} -> {"model": str, "win_rate": float}

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

import uvicorn
import yaml
from fastapi import FastAPI
from pydantic import BaseModel, Field
from routellm.routers.routers import BERTRouter

parser = argparse.ArgumentParser()
parser.add_argument("--config", default="routellm-config.yaml")
parser.add_argument("--port", type=int, default=6060)
args = parser.parse_args()

with open(args.config, encoding="utf-8") as f:
    config = yaml.safe_load(f)

bert = BERTRouter(checkpoint_path=config["checkpoint"])
app = FastAPI()


class RouteRequest(BaseModel):
    prompt: str
    threshold: float = Field(ge=0.0, le=1.0)


@app.post("/route")
def route(req: RouteRequest):
    # RouteLLM rule: strong model when the strong model's win rate >= threshold
    win_rate = float(bert.calculate_strong_win_rate(req.prompt))
    model = config["strong_model"] if win_rate >= req.threshold else config["weak_model"]
    return {"model": model, "win_rate": round(win_rate, 3)}


@app.get("/health")
def health():
    return {"status": "ok"}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=args.port)
