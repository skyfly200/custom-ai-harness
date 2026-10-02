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
    sys.modules["laya"] = types.SimpleNamespace(Router=Fake)
    score = router.make_laya_scorer({"laya_max_chars": 10})
    assert score("a" * 50 + "TAIL") == 0.83
    assert calls["text"].endswith("TAIL") and len(calls["text"]) == 10


if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"): f(); print("ok", n)
