"""Gateway start in Docker: build the config LiteLLM runs from env, then start it.

/app/config.yaml (the repo's config.yaml) stays as it is; the Routing page
edits it. This writes /tmp/config.yaml from it on every start:
  - localhost addresses point at the containers or the host machine
    (OLLAMA_URL, LOCAL_ENGINE_URL)
  - each model in LOCAL_MODELS gets a "local-<name>" entry on Ollama
  - LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY set: Langfuse success and failure
    callbacks on, with prompts and replies left out of the log unless the
    Interceptor asks for them per request (utils/langfuse.js)
  - HARNESS_MODE=passthrough keeps only one model, "passthrough", which the
    Interceptor sends every request to: PASSTHROUGH_MODEL is a model name
    from config.yaml or a LiteLLM provider/model id (openrouter/..., openai/...)
"""
import os
import sys

import yaml

# scripts/start-all.js runs this outside Docker with these set
SOURCE = os.environ.get("GATEWAY_SOURCE", "/app/config.yaml")
TARGET = os.environ.get("GATEWAY_TARGET", "/tmp/config.yaml")
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
                 "config.yaml (e.g. fast-openrouter) or a provider id (e.g. openrouter/anthropic/claude-sonnet-5.5)")
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


def add_langfuse(config: dict) -> None:
    """Nothing is added, so nothing is sent, unless both keys are set."""
    if not (env("LANGFUSE_PUBLIC_KEY") and env("LANGFUSE_SECRET_KEY")):
        return
    settings = config.setdefault("litellm_settings", {})
    for key in ("success_callback", "failure_callback"):
        callbacks = list(settings.get(key) or [])
        if "langfuse" not in callbacks:
            callbacks.append("langfuse")
        settings[key] = callbacks
    # Prompts and replies stay out of Langfuse; the Interceptor sends a header on
    # requests when the Settings page says to log them.
    settings["turn_off_message_logging"] = True


def build(config: dict) -> dict:
    point_local_urls(config)
    add_local_models(config)
    out = passthrough(config) if env("HARNESS_MODE").lower() == "passthrough" else config
    add_langfuse(out)
    return out


def use_federation() -> None:
    """With OPENROUTER_FEDERATION_POLICY_ID (or HARNESS_USER_CREDENTIALS) set, the harness holds the short-lived OpenRouter tokens and the
    Gateway calls OpenRouter through its /openrouter-proxy, using the proxy key as OPENROUTER_API_KEY."""
    on = ("1", "true", "yes", "on")
    renew_main = env("OPENROUTER_MAIN_KEY_RENEW").lower() in on and env("OPENROUTER_MANAGEMENT_KEY")
    if not env("OPENROUTER_FEDERATION_POLICY_ID") and env("HARNESS_USER_CREDENTIALS").lower() not in on and not renew_main:
        return
    key = env("OPENROUTER_PROXY_KEY") or env("LITELLM_MASTER_KEY")
    if not key:
        sys.exit("OPENROUTER_FEDERATION_POLICY_ID and HARNESS_USER_CREDENTIALS need OPENROUTER_PROXY_KEY or LITELLM_MASTER_KEY in .env")
    os.environ["OPENROUTER_API_KEY"] = key
    os.environ["OPENROUTER_API_BASE"] = (env("OPENROUTER_PROXY_URL") or "http://harness:3000").rstrip("/") + "/openrouter-proxy/v1"


if __name__ == "__main__":
    use_federation()
    with open(SOURCE, encoding="utf-8") as f:
        config = build(yaml.safe_load(f))
    with open(TARGET, "w", encoding="utf-8") as f:
        yaml.safe_dump(config, f, sort_keys=False)
    print("Gateway models:", ", ".join(e["model_name"] for e in config["model_list"]), flush=True)
    litellm = os.environ.get("GATEWAY_LITELLM", "litellm")
    host, port = os.environ.get("GATEWAY_HOST", "0.0.0.0"), os.environ.get("GATEWAY_PORT", "4000")
    os.execvp(litellm, [litellm, "--config", TARGET, "--host", host, "--port", port])
