"""Integration tests: every Router backend, run end to end.

Each test starts the real Router (`python router.py --config ... --port ...`, or
`router.load_config` in-process for laya) and calls POST /route over HTTP. Only
what needs credentials or model weights is replaced:

  routellm   real RouteLLM BERTRouter + torch, on a tiny random BERT checkpoint
             built locally (no Hugging Face download)
  laya       real laya.Router; only its checkpoint Agent is a stub (keeps laya's
             own question validation)
  systemone  real `laya-serve` HTTP server (the Jev /v1/systemone protocol, with
             bearer auth), backed by the same stub Agent
  llm        a local OpenAI-compatible server replying like a reasoning model
  custom     a scorer module written to a temp dir

Live mode (opt in; each needs network or credentials):
  ROUTER_LIVE_ROUTELLM=1          real routellm/bert_gpt4_augmented checkpoint
  ROUTER_LIVE_LAYA=1              real Laya weights from Hugging Face
  ROUTER_LIVE_JEV_URL=<base url>  a real Jev or laya-serve (key: ROUTER_LIVE_JEV_KEY)
  ROUTER_LIVE_LLM_URL=<base url>  a real OpenAI-compatible reasoning model
      with ROUTER_LIVE_LLM_MODEL (and ROUTER_LIVE_LLM_KEY if it needs one)

Run: pip install -r requirements-test.txt && python -m pytest test/test_router_backends.py -v
"""
import json
import os
import socket
import subprocess
import sys
import threading
import time

import pytest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, ROOT)
os.environ.setdefault("OPENAI_API_KEY", "x")

httpx = pytest.importorskip("httpx")
yaml = pytest.importorskip("yaml")

BASE = {"strong_model": "S", "weak_model": "W", "weak_model_max_tokens": 7000, "weak_model_overflow": "O"}
HARD = "Refactor the auth module across services and find the race condition in token refresh."


# -- helpers ---------------------------------------------------------------

def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_healthy(url, proc=None, timeout=120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc is not None and proc.poll() is not None:
            raise AssertionError(f"router exited with {proc.returncode}:\n{proc.stdout.read()}")
        try:
            if httpx.get(url + "/health", timeout=2).status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(0.2)
    raise AssertionError(f"{url} never became healthy")


def serve_app(app):
    """Run an ASGI app with uvicorn on a background thread; returns (base_url, stop)."""
    import uvicorn
    port = free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{port}"
    wait_healthy(url, timeout=30)

    def stop():
        server.should_exit = True
        thread.join(10)
    return url, stop


@pytest.fixture
def run_router(tmp_path):
    """Start `python router.py` as a subprocess with the given config; returns its base URL."""
    procs = []

    def start(cfg, env=None):
        path = tmp_path / "router-config.yaml"
        path.write_text(yaml.safe_dump({**BASE, **cfg}))
        port = free_port()
        proc = subprocess.Popen(
            [sys.executable, os.path.join(ROOT, "router.py"), "--config", str(path), "--port", str(port)],
            cwd=tmp_path, env={**os.environ, **(env or {})},
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        procs.append(proc)
        url = f"http://127.0.0.1:{port}"
        wait_healthy(url, proc)
        return url

    yield start
    for p in procs:
        p.terminate()
        p.wait(10)


def route(url, prompt=HARD, threshold=0.5, tokens=0):
    res = httpx.post(url + "/route", json={"prompt": prompt, "threshold": threshold, "tokens": tokens}, timeout=120)
    assert res.status_code == 200, res.text
    return res.json()


def assert_routes(body, threshold=0.5):
    assert 0.0 <= body["win_rate"] <= 1.0
    assert body["model"] == ("S" if body["win_rate"] >= threshold else "W")


# -- routellm (default backend) --------------------------------------------

@pytest.fixture(scope="module")
def tiny_bert(tmp_path_factory):
    """A random 1-layer BERT with RouteLLM's 3-label head, saved like a real checkpoint."""
    pytest.importorskip("routellm")
    transformers = pytest.importorskip("transformers")
    d = tmp_path_factory.mktemp("tiny-bert")
    words = ["[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]"] + sorted(set(HARD.lower().replace(".", "").split()))
    (d / "vocab.txt").write_text("\n".join(words) + "\n")
    transformers.BertTokenizer(str(d / "vocab.txt")).save_pretrained(d)
    cfg = transformers.BertConfig(vocab_size=len(words), hidden_size=16, num_hidden_layers=1,
                                  num_attention_heads=2, intermediate_size=32, num_labels=3)
    transformers.BertForSequenceClassification(cfg).save_pretrained(d)
    return str(d)


def test_routellm_backend_end_to_end(run_router, tiny_bert):
    url = run_router({"checkpoint": tiny_bert})  # no `backend:` key: the default
    assert httpx.get(url + "/health").json() == {"status": "ok", "backend": "routellm"}
    body = route(url)
    assert_routes(body)
    assert route(url, threshold=0.0)["model"] == "S"
    assert route(url, threshold=1.0, tokens=9000)["model"] == "O"


@pytest.mark.skipif(not os.environ.get("ROUTER_LIVE_ROUTELLM"), reason="set ROUTER_LIVE_ROUTELLM=1")
def test_routellm_live_checkpoint(run_router):
    url = run_router({"backend": "routellm", "checkpoint": "routellm/bert_gpt4_augmented"})
    assert_routes(route(url))


# -- laya in-process and laya-serve (Jev protocol) ------------------------

class StubAgent:
    """Stands in for laya.agent.Agent (a Hugging Face checkpoint). P(yes) grows with prompt length."""
    built = []
    check_question = None  # laya.agent.Agent._check_question, set before patching

    def __init__(self, repo, **kwargs):
        StubAgent.built.append(repo)

    def system_one(self, state, questions, lang=None, **kwargs):
        for qid, qdef in questions.items():
            StubAgent.check_question(qid, qdef)  # laya's own validation of our question
        text = state if isinstance(state, str) else json.dumps(state)
        p = round(min(1.0, len(text) / 100), 4)
        return {"model": "laya-rl-agent",
                "answers": {qid: {"type": "noul", "noul": p, "confidence": max(p, 1 - p)} for qid in questions},
                "usage": {}}


@pytest.fixture
def stub_laya(monkeypatch):
    laya_agent = pytest.importorskip("laya.agent")
    StubAgent.check_question = staticmethod(laya_agent.Agent._check_question)
    monkeypatch.setattr(laya_agent, "Agent", StubAgent)
    StubAgent.built.clear()


def laya_router_app(cfg):
    import router
    from fastapi.testclient import TestClient
    path = os.path.join(os.environ.get("TMPDIR", "/tmp"), f"laya-cfg-{os.getpid()}.yaml")
    with open(path, "w") as f:
        yaml.safe_dump({**BASE, **cfg}, f)
    try:
        router.load_config(path)
    finally:
        os.remove(path)
    return TestClient(router.app)


def test_laya_backend_end_to_end(stub_laya):
    client = laya_router_app({"backend": "laya", "laya_max_chars": 60})
    assert client.get("/health").json()["backend"] == "laya"
    hard = client.post("/route", json={"prompt": "x" * 500, "threshold": 0.5}).json()
    assert hard == {"model": "S", "win_rate": 0.6}  # tail clipped to 60 chars -> 0.6
    easy = client.post("/route", json={"prompt": "fix typo", "threshold": 0.5}).json()
    assert easy == {"model": "W", "win_rate": 0.08}
    assert StubAgent.built  # laya.Router really resolved and built a checkpoint


@pytest.mark.skipif(not os.environ.get("ROUTER_LIVE_LAYA"), reason="set ROUTER_LIVE_LAYA=1")
def test_laya_live_weights():
    pytest.importorskip("laya")
    client = laya_router_app({"backend": "laya"})
    hard = client.post("/route", json={"prompt": HARD, "threshold": 0.5}).json()
    easy = client.post("/route", json={"prompt": "What does `ls` do?", "threshold": 0.5}).json()
    assert_routes(hard)
    assert_routes(easy)
    assert hard["win_rate"] > easy["win_rate"]


@pytest.fixture
def laya_serve(stub_laya, monkeypatch):
    """Real `laya-serve` app (Jev /v1/systemone protocol) requiring a bearer key."""
    from laya import Router
    from laya.serve import create_app
    monkeypatch.setenv("LAYA_API_KEY", "secret")
    url, stop = serve_app(create_app(router=Router()))
    yield url
    stop()


def test_systemone_backend_against_laya_serve(run_router, laya_serve):
    url = run_router({"backend": "systemone", "base_url": laya_serve + "/", "api_key_env": "TEST_JEV_KEY",
                      "max_chars": 80}, env={"TEST_JEV_KEY": "secret"})
    assert httpx.get(url + "/health").json()["backend"] == "systemone"
    assert route(url, prompt="y" * 300) == {"model": "S", "win_rate": 0.92}  # 80-char tail as {"body": ...} JSON
    assert route(url, prompt="hi")["model"] == "W"


def test_systemone_backend_wrong_key_is_an_error(run_router, laya_serve):
    url = run_router({"backend": "systemone", "base_url": laya_serve, "api_key_env": "TEST_JEV_KEY"},
                     env={"TEST_JEV_KEY": "wrong"})
    res = httpx.post(url + "/route", json={"prompt": "hi", "threshold": 0.5})
    assert res.status_code == 500  # 401 from Jev surfaces; the Interceptor then falls back


@pytest.mark.skipif(not os.environ.get("ROUTER_LIVE_JEV_URL"), reason="set ROUTER_LIVE_JEV_URL")
def test_systemone_live(run_router):
    cfg = {"backend": "systemone", "base_url": os.environ["ROUTER_LIVE_JEV_URL"], "api_key_env": "ROUTER_LIVE_JEV_KEY"}
    if os.environ.get("ROUTER_LIVE_JEV_MODEL"):
        cfg["model"] = os.environ["ROUTER_LIVE_JEV_MODEL"]
    assert_routes(route(run_router(cfg)))


# -- llm (OpenAI-compatible reasoning model) -------------------------------

@pytest.fixture
def fake_reasoner():
    from fastapi import FastAPI, Header
    app, seen = FastAPI(), []

    @app.get("/health")
    def health():
        return {}

    @app.post("/v1/chat/completions")
    def chat(body: dict, authorization: str = Header(default="")):
        seen.append({"auth": authorization, **body})
        hard = "refactor" in body["messages"][-1]["content"].lower()
        content = "<think>Multiple services... maybe 0.4? No, the race makes it 0.95.</think>\n" + \
                  ("0.9" if hard else "Score: 0.1")
        return {"choices": [{"message": {"role": "assistant", "content": content}}]}

    url, stop = serve_app(app)
    yield url, seen
    stop()


def test_llm_backend_end_to_end(run_router, fake_reasoner):
    base, seen = fake_reasoner
    url = run_router({"backend": "llm", "base_url": base + "/v1", "model": "deepseek/deepseek-r1",
                      "api_key_env": "TEST_LLM_KEY"}, env={"TEST_LLM_KEY": "k"})
    assert route(url) == {"model": "S", "win_rate": 0.9}
    assert route(url, prompt="What does ls do?") == {"model": "W", "win_rate": 0.1}
    assert seen[0]["auth"] == "Bearer k" and seen[0]["model"] == "deepseek/deepseek-r1"
    assert seen[0]["messages"][0]["role"] == "system" and seen[0]["max_tokens"] == 2048


@pytest.mark.skipif(not os.environ.get("ROUTER_LIVE_LLM_URL"), reason="set ROUTER_LIVE_LLM_URL and ROUTER_LIVE_LLM_MODEL")
def test_llm_live(run_router):
    url = run_router({"backend": "llm", "base_url": os.environ["ROUTER_LIVE_LLM_URL"],
                      "model": os.environ["ROUTER_LIVE_LLM_MODEL"], "api_key_env": "ROUTER_LIVE_LLM_KEY"})
    assert_routes(route(url))


# -- custom ----------------------------------------------------------------

def test_custom_backend_end_to_end(run_router, tmp_path):
    (tmp_path / "my_scorer.py").write_text(
        "def make(config):\n    return lambda prompt: config['fixed']\n")
    url = run_router({"backend": "custom", "scorer": "my_scorer:make", "fixed": 0.75},
                     env={"PYTHONPATH": str(tmp_path)})
    assert route(url) == {"model": "S", "win_rate": 0.75}
