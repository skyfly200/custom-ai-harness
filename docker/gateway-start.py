"""Gateway start in Docker: build the config LiteLLM runs from env, then start it.

/app/config.yaml (the repo's config.yaml) stays as it is; the Routing page
edits it. This writes /tmp/config.yaml from it on every start:
  - localhost addresses point at the containers or the host machine
    (OLLAMA_URL, LOCAL_ENGINE_URL)
  - each model in LOCAL_MODELS gets a "local-<name>" entry on Ollama
  - HARNESS_MODE=passthrough keeps only one model, "passthrough", which the
    Interceptor sends every request to: PASSTHROUGH_MODEL is a model name
    from config.yaml or a LiteLLM provider/model id (openrouter/..., openai/...)
"""
import os
import sys

import yaml

SOURCE, TARGET = "/app/config.yaml", "/tmp/config.yaml"
LOCAL_URLS = {
    "http://localhost:11434": "OLLAMA_URL",  # also the base for LOCAL_MODELS
    "http://localhost:8000": "LOCAL_ENGINE_URL",
}


def env(name: str) -> str:
    return os.environ.get(name, "").strip()


def point_local_urls(config: dict) -> None:
    for entry in config.get("model_list") or []:
        params = entry.get("litellm_params") or {}
        base = str(params.get("api_base", ""))
        for local, var in LOCAL_URLS.items():
            if base.startswith(local) and env(var):
                params["api_base"] = env(var).rstrip("/") + base[len(local):]


def add_local_models(config: dict) -> None:
    base = (env("OLLAMA_URL") or "http://localhost:11434").rstrip("/") + "/v1"
    names = {e.get("model_name") for e in config.get("model_list") or []}
    for model in env("LOCAL_MODELS").replace(",", " ").split():
        if f"local-{model}" in names:
            continue
        config.setdefault("model_list", []).append({
            "model_name": f"local-{model}",
            "litellm_params": {"model": f"openai/{model}", "api_base": base, "api_key": "dummy",
                               "max_parallel_requests": 2},
        })


def passthrough(config: dict) -> dict:
    target = env("PASSTHROUGH_MODEL")
    if not target:
        sys.exit("HARNESS_MODE=passthrough needs PASSTHROUGH_MODEL in .env: a model name from "
                 "config.yaml (e.g. or-claude-sonnet-5.5) or a provider id (e.g. openrouter/anthropic/claude-sonnet-5.5)")
    known = {e.get("model_name"): e for e in config.get("model_list") or []}
    if target in known:
        params = dict(known[target]["litellm_params"])
    else:
        # LiteLLM finds the provider's key in its usual variable (OPENROUTER_API_KEY, OPENAI_API_KEY, ...)
        params = {"model": target}
        if env("PASSTHROUGH_API_BASE"):
            params["api_base"] = env("PASSTHROUGH_API_BASE")
        if env("PASSTHROUGH_API_KEY"):
            params["api_key"] = "os.environ/PASSTHROUGH_API_KEY"
    return {
        "general_settings": config.get("general_settings") or {},
        "model_list": [{"model_name": "passthrough", "litellm_params": params}],
        "litellm_settings": {k: v for k, v in (config.get("litellm_settings") or {}).items() if k != "fallbacks"},
        "router_settings": config.get("router_settings") or {},
    }


def build(config: dict) -> dict:
    point_local_urls(config)
    add_local_models(config)
    return passthrough(config) if env("HARNESS_MODE").lower() == "passthrough" else config


if __name__ == "__main__":
    with open(SOURCE, encoding="utf-8") as f:
        config = build(yaml.safe_load(f))
    with open(TARGET, "w", encoding="utf-8") as f:
        yaml.safe_dump(config, f, sort_keys=False)
    print("Gateway models:", ", ".join(e["model_name"] for e in config["model_list"]), flush=True)
    os.execvp("litellm", ["litellm", "--config", TARGET, "--host", "0.0.0.0", "--port", "4000"])
