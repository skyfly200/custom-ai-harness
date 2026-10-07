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


if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"): f(); print("ok", n)
