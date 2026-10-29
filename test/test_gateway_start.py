"""docker/gateway-start.py: the Gateway config built from config.yaml and .env.
Run: python -m pytest test/test_gateway_start.py
"""
import copy, importlib.util, os, pytest, yaml

ROOT = os.path.join(os.path.dirname(__file__), "..")
spec = importlib.util.spec_from_file_location("gateway_start", os.path.join(ROOT, "docker", "gateway-start.py"))
gateway_start = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway_start)
CONFIG = yaml.safe_load(open(os.path.join(ROOT, "config.yaml"), encoding="utf-8"))


def build(monkeypatch, **env):
    for k in ("HARNESS_MODE", "PASSTHROUGH_MODEL", "PASSTHROUGH_API_BASE", "PASSTHROUGH_API_KEY",
              "LOCAL_MODELS", "OLLAMA_URL", "LOCAL_ENGINE_URL", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"):
        monkeypatch.delenv(k, raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    return gateway_start.build(copy.deepcopy(CONFIG))


def model(config, name):
    return next(e["litellm_params"] for e in config["model_list"] if e["model_name"] == name)


def test_unset_env_keeps_config_yaml(monkeypatch):
    assert build(monkeypatch) == CONFIG


def test_local_urls_and_models(monkeypatch):
    c = build(monkeypatch, OLLAMA_URL="http://ollama:11434", LOCAL_ENGINE_URL="http://host.docker.internal:8000",
              LOCAL_MODELS="qwen2.5-coder:7b, gemma3:4b")
    assert model(c, "fallback-ollama")["api_base"] == "http://ollama:11434/v1"
    assert model(c, "local-engine")["api_base"] == "http://host.docker.internal:8000/v1"
    assert model(c, "local-gemma3:4b") == {"model": "openai/gemma3:4b", "api_base": "http://ollama:11434/v1",
                                          "api_key": "dummy", "max_parallel_requests": 2}
    assert c["litellm_settings"]["fallbacks"] == CONFIG["litellm_settings"]["fallbacks"]


def test_passthrough_to_a_config_model(monkeypatch):
    c = build(monkeypatch, HARNESS_MODE="passthrough", PASSTHROUGH_MODEL="fast-openrouter")
    assert [e["model_name"] for e in c["model_list"]] == ["passthrough"]
    assert model(c, "passthrough")["model"] == "openrouter/openai/gpt-4o-mini"
    assert "fallbacks" not in c["litellm_settings"]
    assert c["general_settings"]["master_key"] == "os.environ/LITELLM_MASTER_KEY"


def test_passthrough_to_a_provider_id(monkeypatch):
    c = build(monkeypatch, HARNESS_MODE="passthrough", PASSTHROUGH_MODEL="openai/my-model",
              PASSTHROUGH_API_BASE="http://vllm:8000/v1", PASSTHROUGH_API_KEY="k")
    assert model(c, "passthrough") == {"model": "openai/my-model", "api_base": "http://vllm:8000/v1",
                                       "api_key": "os.environ/PASSTHROUGH_API_KEY"}


def test_passthrough_needs_a_model(monkeypatch):
    with pytest.raises(SystemExit, match="PASSTHROUGH_MODEL"):
        build(monkeypatch, HARNESS_MODE="passthrough")


def test_federation_points_the_gateway_at_the_harness_proxy(monkeypatch):
    for k in ("OPENROUTER_FEDERATION_POLICY_ID", "OPENROUTER_PROXY_KEY", "OPENROUTER_PROXY_URL", "LITELLM_MASTER_KEY",
              "OPENROUTER_API_KEY", "OPENROUTER_API_BASE"):
        monkeypatch.delenv(k, raising=False)
    gateway_start.use_federation()
    assert "OPENROUTER_API_BASE" not in os.environ  # off: the static key path is untouched
    monkeypatch.setenv("OPENROUTER_FEDERATION_POLICY_ID", "pol_1")
    with pytest.raises(SystemExit):
        gateway_start.use_federation()
    monkeypatch.setenv("LITELLM_MASTER_KEY", "sk-master")
    monkeypatch.setenv("OPENROUTER_PROXY_URL", "http://harness:3000/")
    gateway_start.use_federation()
    assert os.environ["OPENROUTER_API_KEY"] == "sk-master"
    assert os.environ["OPENROUTER_API_BASE"] == "http://harness:3000/openrouter-proxy/v1"
    monkeypatch.delenv("OPENROUTER_API_KEY"); monkeypatch.delenv("OPENROUTER_API_BASE")

def test_langfuse_off_without_both_keys(monkeypatch):
    monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)
    assert build(monkeypatch, LANGFUSE_PUBLIC_KEY="pk-lf-1") == CONFIG


def test_langfuse_callbacks_with_both_keys(monkeypatch):
    config = build(monkeypatch, LANGFUSE_PUBLIC_KEY="pk-lf-1", LANGFUSE_SECRET_KEY="sk-lf-1")
    settings = config["litellm_settings"]
    assert settings["success_callback"] == ["langfuse"]
    assert settings["failure_callback"] == ["langfuse"]
    assert settings["turn_off_message_logging"] is True
    assert settings["drop_params"] is True  # the rest is kept


def test_langfuse_keeps_other_callbacks_and_passthrough(monkeypatch):
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk")
    cfg = copy.deepcopy(CONFIG)
    cfg["litellm_settings"]["success_callback"] = ["custom"]
    monkeypatch.setenv("HARNESS_MODE", "passthrough")
    monkeypatch.setenv("PASSTHROUGH_MODEL", "fast-openrouter")
    out = gateway_start.build(cfg)
    assert out["litellm_settings"]["success_callback"] == ["custom", "langfuse"]


def test_main_key_renewal_points_the_gateway_at_the_harness_proxy(monkeypatch):
    for k in ("OPENROUTER_FEDERATION_POLICY_ID", "HARNESS_USER_CREDENTIALS", "OPENROUTER_PROXY_URL", "OPENROUTER_API_KEY", "OPENROUTER_API_BASE"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("LITELLM_MASTER_KEY", "sk-master")
    monkeypatch.setenv("OPENROUTER_MAIN_KEY_RENEW", "1")
    gateway_start.use_federation()
    assert "OPENROUTER_API_BASE" not in os.environ  # no management key yet
    monkeypatch.setenv("OPENROUTER_MANAGEMENT_KEY", "sk-or-m")
    gateway_start.use_federation()
    assert os.environ["OPENROUTER_API_BASE"].endswith("/openrouter-proxy/v1")
    monkeypatch.delenv("OPENROUTER_API_KEY"); monkeypatch.delenv("OPENROUTER_API_BASE")
