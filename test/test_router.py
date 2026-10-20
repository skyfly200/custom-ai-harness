"""Router contract tests with a stub scorer (no model download needed).
Run: python -m pytest test/test_router.py   (or python test/test_router.py)
"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("OPENAI_API_KEY", "x")

from fastapi.testclient import TestClient
import router

CFG = {"strong_model": "S", "weak_model": "W", "weak_model_max_tokens": 7000,
       "weak_model_overflow": "O", "backend": "laya"}


def client(win_rate):
    router.config.clear(); router.config.update(CFG)
    router.scorer = lambda prompt: win_rate
    return TestClient(router.app)


def test_hard_prompt_goes_strong():
    r = client(0.9).post("/route", json={"prompt": "x", "threshold": 0.5}).json()
    assert r == {"model": "S", "win_rate": 0.9}


def test_easy_prompt_goes_weak_and_overflows():
    assert client(0.1).post("/route", json={"prompt": "x", "threshold": 0.5}).json()["model"] == "W"
    assert client(0.1).post("/route", json={"prompt": "x", "threshold": 0.5, "tokens": 9000}).json()["model"] == "O"


def test_weak_tool_request_goes_to_tool_model():
    c = client(0.1); router.config["weak_model_tools"] = "T"
    assert c.post("/route", json={"prompt": "x", "threshold": 0.5, "tools": True, "tokens": 9000}).json()["model"] == "T"
    assert c.post("/route", json={"prompt": "x", "threshold": 0.5, "tools": False}).json()["model"] == "W"
    c = client(0.9); router.config["weak_model_tools"] = "T"
    assert c.post("/route", json={"prompt": "x", "threshold": 0.5, "tools": True}).json()["model"] == "S"


def test_strong_tool_request_goes_to_strong_tool_model():
    c = client(0.9); router.config["strong_model_tools"] = "ST"
    assert c.post("/route", json={"prompt": "x", "threshold": 0.5, "tools": True}).json()["model"] == "ST"
    assert c.post("/route", json={"prompt": "x", "threshold": 0.5, "tools": False}).json()["model"] == "S"


def test_low_threshold_pushes_strong():
    assert client(0.3).post("/route", json={"prompt": "x", "threshold": 0.2}).json()["model"] == "S"


def test_laya_scorer_reads_noul_probability():
    import types
    calls = {}
    class Fake:
        def __init__(self, **kw): pass
        def predict(self, text, questions):
            calls["text"] = text
            return {"answers": {"hard": {"noul": 0.83}}}
    real = sys.modules.get("laya")
    sys.modules["laya"] = types.SimpleNamespace(Router=Fake)
    try:
        score = router.make_laya_scorer({"laya_max_chars": 10})
        assert score("a" * 50 + "TAIL") == 0.83
    finally:  # don't leak the fake into test_router_backends.py
        if real is None: sys.modules.pop("laya")
        else: sys.modules["laya"] = real
    assert calls["text"].endswith("TAIL") and len(calls["text"]) == 10


def test_load_dotenv_fills_only_unset_keys(tmp_path=None):
    import tempfile
    path = os.path.join(tempfile.mkdtemp(), ".env")
    with open(path, "w") as f:
        f.write('# comment\nDOTENV_A="from-file"\nDOTENV_B=from-file\nnot a pair\n')
    os.environ["DOTENV_B"] = "from-shell"
    router.load_dotenv(path)
    assert os.environ["DOTENV_A"] == "from-file" and os.environ["DOTENV_B"] == "from-shell"
    router.load_dotenv(path + ".missing")  # no file is fine


def test_classifier_error_is_a_502_with_the_upstream_reason():
    import httpx
    undo = _mock(lambda req: httpx.Response(401, json={"error": {"message": "No auth credentials found"}}))
    try:
        c = client(0)
        router.scorer = router.make_systemone_scorer({"base_url": "http://jev"})
        r = c.post("/route", json={"prompt": "x", "threshold": 0.5})
    finally:
        undo()
    assert r.status_code == 502
    assert "HTTP 401 from http://jev/v1/systemone" in r.json()["error"] and "No auth credentials" in r.json()["error"]


def test_parse_score_handles_reasoning_output():
    assert router.parse_score("<think>maybe 0.2? no 0.9</think>\nScore: 0.7") == 0.7
    assert router.parse_score("1.5") == 1.0
    try:
        router.parse_score("n/a"); assert False
    except ValueError:
        pass


def _mock(handler):
    import httpx
    real = httpx.Client
    httpx.Client = lambda **kw: real(transport=httpx.MockTransport(handler), **kw)
    return lambda: setattr(httpx, "Client", real)


def test_systemone_scorer_posts_protocol_and_auth():
    import httpx, json
    seen = {}
    def handler(req):
        seen.update(url=str(req.url), auth=req.headers.get("authorization"), body=json.loads(req.content))
        return httpx.Response(200, json={"answers": {"hard": {"noul": 0.42}}})
    undo = _mock(handler); os.environ["JEV_KEY"] = "k"
    try:
        score = router.make_systemone_scorer({"base_url": "http://jev/", "api_key_env": "JEV_KEY", "model": "jev-1"})
        assert score("hello") == 0.42
    finally:
        undo()
    assert seen["url"] == "http://jev/v1/systemone" and seen["auth"] == "Bearer k"
    assert seen["body"]["state"] == {"body": "hello"} and seen["body"]["model"] == "jev-1"


def test_llm_scorer_parses_chat_completion():
    import httpx
    undo = _mock(lambda req: httpx.Response(200, json={"choices": [{"message": {"content": "<think>x</think>0.85"}}]}))
    try:
        assert router.make_llm_scorer({"base_url": "http://m/v1", "model": "r1"})("p") == 0.85
    finally:
        undo()


def test_custom_scorer_loads_factory():
    import types
    sys.modules["my_scorer"] = types.SimpleNamespace(make=lambda cfg: (lambda p: 0.5))
    assert router.make_custom_scorer({"scorer": "my_scorer:make"})("x") == 0.5


def test_admin_switches_backend_and_reload_restores_file(tmp_path=None):
    import tempfile, types
    sys.modules["stub_scorer"] = types.SimpleNamespace(make=lambda cfg: (lambda p: 0.9))
    cfg = os.path.join(tmp_path or tempfile.mkdtemp(), "router.yaml")
    with open(cfg, "w") as f:
        f.write("strong_model: S\nweak_model: W\nbackend: custom\nscorer: stub_scorer:make\n")
    router.load_config(cfg)
    c = TestClient(router.app)
    assert c.get("/health").json()["backend"] == "custom"

    # llm without base_url in the config can't be built: refused, nothing changes
    r = c.post("/admin/backend", json={"backend": "llm"})
    assert r.status_code == 400 and "base_url" in r.json()["error"]
    assert c.post("/admin/backend", json={"backend": "nope"}).status_code == 400
    assert c.get("/health").json()["backend"] == "custom"

    router.BACKENDS["stub2"] = lambda cfg: (lambda p: 0.1)
    try:
        assert c.post("/admin/backend", json={"backend": "stub2"}).json()["backend"] == "stub2"
        assert c.post("/route", json={"prompt": "x", "threshold": 0.5}).json()["model"] == "W"
        assert c.post("/admin/reload").json()["backend"] == "custom"
        assert c.post("/route", json={"prompt": "x", "threshold": 0.5}).json()["model"] == "S"
    finally:
        del router.BACKENDS["stub2"]


def test_reload_keeps_running_config_when_file_is_bad(tmp_path=None):
    import tempfile, types
    sys.modules["stub_scorer"] = types.SimpleNamespace(make=lambda cfg: (lambda p: 0.9))
    cfg = os.path.join(tmp_path or tempfile.mkdtemp(), "router.yaml")
    with open(cfg, "w") as f:
        f.write("strong_model: S\nweak_model: W\nbackend: custom\nscorer: stub_scorer:make\n")
    router.load_config(cfg)
    with open(cfg, "w") as f:
        f.write("strong_model: S2\nweak_model: W\nbackend: missing\n")
    c = TestClient(router.app)
    assert c.post("/admin/reload").status_code == 400
    assert router.config["strong_model"] == "S" and c.get("/health").json()["backend"] == "custom"


def _load_stub(text):
    import tempfile, types
    sys.modules["stub_scorer"] = types.SimpleNamespace(make=lambda cfg: (lambda p: float(cfg.get("max_chars", 90)) / 100))
    path = os.path.join(tempfile.mkdtemp(), "router.yaml")
    with open(path, "w") as f:
        f.write(text)
    router.load_config(path)
    return path, TestClient(router.app)


STUB_YAML = """# Router config
strong_model: S          # the strong one
weak_model: W
weak_model_tools: T
backend: custom
scorer: stub_scorer:make
# base_url: http://example
"""


def test_admin_config_changes_models_and_rebuilds_scorer():
    _, c = _load_stub(STUB_YAML)
    assert c.post("/route", json={"prompt": "x", "threshold": 0.5}).json()["model"] == "S"
    old = router.scorer
    assert c.post("/admin/config", json={"changes": {"strong_model": "S2"}}).status_code == 200
    assert router.scorer is old  # model names alone don't rebuild the classifier
    assert c.post("/route", json={"prompt": "x", "threshold": 0.5}).json()["model"] == "S2"
    # a classifier setting rebuilds it: win rate 0.1 now
    assert c.post("/admin/config", json={"changes": {"max_chars": 10}}).status_code == 200
    assert c.post("/route", json={"prompt": "x", "threshold": 0.5}).json()["model"] == "W"
    # optional keys can be removed, required ones can't, unknown ones are refused
    assert c.post("/admin/config", json={"changes": {"weak_model_tools": None}}).status_code == 200
    assert "weak_model_tools" not in router.config
    assert c.post("/admin/config", json={"changes": {"weak_model": ""}}).status_code == 400
    assert c.post("/admin/config", json={"changes": {"evil": 1}}).status_code == 400
    assert c.post("/admin/config", json={"changes": {"max_chars": "lots"}}).status_code == 400
    assert router.config["weak_model"] == "W"


def test_admin_save_keeps_comments_and_layout():
    path, c = _load_stub(STUB_YAML)
    c.post("/admin/config", json={"changes": {"strong_model": "S2", "weak_model_tools": None,
                                              "base_url": "https://openrouter.ai/api", "timeout": 5}})
    assert c.post("/admin/save").status_code == 200
    text = open(path).read()
    assert "# Router config" in text
    assert "strong_model: S2          # the strong one" in text
    assert "# weak_model_tools: T" in text
    assert "base_url: https://openrouter.ai/api" in text and "timeout: 5.0" in text
    assert c.post("/admin/reload").json()["backend"] == "custom"
    assert router.config["strong_model"] == "S2" and "weak_model_tools" not in router.config


def test_env_overrides_mode_preset_and_models():
    assert router.env_overrides({}) == {}
    assert router.env_overrides({"HARNESS_MODE": "passthrough"}) == {}
    jev = router.env_overrides({"HARNESS_MODE": "Jev", "STRONG_MODEL": "or-claude-sonnet-5.5"})
    assert jev["backend"] == "systemone" and jev["base_url"] == "https://openrouter.ai/api"
    assert jev["strong_model"] == "or-claude-sonnet-5.5"
    llm = router.env_overrides({"HARNESS_MODE": "llm", "ROUTER_MODEL": "deepseek/deepseek-r1", "ROUTER_TIMEOUT": "8"})
    assert llm["model"] == "deepseek/deepseek-r1" and llm["timeout"] == 8.0
    assert router.env_overrides({"ROUTER_BACKEND": "laya", "WEAK_MODEL": " "}) == {"backend": "laya"}


def test_env_wins_over_the_config_file(tmp_path=None):
    import tempfile, types
    sys.modules["stub_env_scorer"] = types.SimpleNamespace(make=lambda cfg: (lambda p: 0.0))
    path = os.path.join(tempfile.mkdtemp(), "c.yaml")
    open(path, "w").write("backend: custom\nscorer: stub_env_scorer:make\nstrong_model: S\nweak_model: W\n")
    os.environ["WEAK_MODEL"] = "local-qwen"
    try:
        router.load_config(path)
    finally:
        del os.environ["WEAK_MODEL"]
    assert router.config["weak_model"] == "local-qwen" and router.config["strong_model"] == "S"


def test_old_local_engine_names_are_renamed(tmp_path=None):
    import tempfile, types
    sys.modules["stub_env_scorer"] = types.SimpleNamespace(make=lambda cfg: (lambda p: 0.0))
    path = os.path.join(tempfile.mkdtemp(), "c.yaml")
    open(path, "w").write("backend: custom\nscorer: stub_env_scorer:make\nstrong_model: claude-sonnet-5\nweak_model: W\n")
    router.load_config(path)
    assert router.config["strong_model"] == "local-engine" and router.config["weak_model"] == "W"


if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"): f(); print("ok", n)


def test_ask_answers_yes_no_questions_with_the_classifier():
    c = client(0.5)
    def score(prompt): return 0.5
    score.ask = lambda text, qs: {name: (0.9 if "rm -rf" in text else 0.1) for name in qs}
    router.scorer = score
    r = c.post("/ask", json={"text": "rm -rf /", "questions": {"destructive": "Does it delete data?"}})
    assert r.status_code == 200 and r.json() == {"answers": {"destructive": 0.9}}
    assert c.post("/ask", json={"text": "x", "questions": {}}).status_code == 422


def test_ask_needs_a_backend_that_takes_questions():
    c = client(0.5)  # a plain scorer, like RouteLLM's BERT
    r = c.post("/ask", json={"text": "ls", "questions": {"destructive": "?"}})
    assert r.status_code == 501 and "systemone" in r.json()["error"]


def test_yes_no_builds_the_jev_questions_block():
    assert router.yes_no({"a": "Is it?"}) == {"a": {"type": "noul", "instructions": "Is it?"}}
