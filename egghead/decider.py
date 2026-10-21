"""Decider backends: a running `strands-decider serve`, an in-process engine, or replayed answers."""

from __future__ import annotations

import json
import os
import urllib.request
from typing import Protocol

DEFAULT_MODEL = "StrandsAgents/strands-decider-2B-qwen3.5-v1-2610"
PUBLIC_DECIDER_URL = "https://api.decider.cloud"
DEFAULT_USER_AGENT = "egghead-decider-client/1.0 (+https://github.com/tkuhemiya/Egg-Head)"


class Decider(Protocol):
    def ask(self, state: str, questions: dict) -> dict:
        """One batch against one state -> {question id: answer}."""


def _http_headers() -> dict[str, str]:
    ua = os.environ.get("EGGHEAD_DECIDER_USER_AGENT", DEFAULT_USER_AGENT)
    return {"content-type": "application/json", "user-agent": ua}


class HttpDecider:
    def __init__(self, url: str = "http://127.0.0.1:8000"):
        self.url = url.rstrip("/")

    def ask(self, state: str, questions: dict) -> dict:
        body = json.dumps({"state": state, "questions": questions}).encode()
        req = urllib.request.Request(
            self.url + "/v1/systemone", body, headers=_http_headers()
        )
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.load(r)["answers"]


class LocalDecider:
    def __init__(self, checkpoint: str = DEFAULT_MODEL, device: str = "cpu"):
        from strands_decider.infer import load_engine

        self.engine = load_engine(checkpoint, device=device)

    def ask(self, state: str, questions: dict) -> dict:
        from strands_decider.schema import SystemOneRequest

        resp = self.engine.evaluate(SystemOneRequest(state=state, questions=questions))
        return resp.model_dump()["answers"]


class ScriptedDecider:
    """Replays prepared answers in order. For tests and for demo runs that must not vary."""

    def __init__(self, scripted: list[dict]):
        self._scripted = list(scripted)
        self.calls: list[tuple[str, dict]] = []

    def ask(self, state: str, questions: dict) -> dict:
        self.calls.append((state, questions))
        answers = self._scripted.pop(0)
        return {q: a for q, a in answers.items() if q in questions}


def decider_from_env() -> Decider:
    """Pick a Decider backend from environment (see AGENTS.md).

    EGGHEAD_DECIDER_BACKEND:
      public | hosted  — free API at api.decider.cloud (default when unset)
      http             — strands-decider serve base URL (EGGHEAD_DECIDER_URL or :8000)
      local            — in-process HF weights (EGGHEAD_DECIDER_CHECKPOINT, optional DEVICE)
    """
    backend = os.environ.get("EGGHEAD_DECIDER_BACKEND", "public").strip().lower()
    if backend in ("public", "hosted"):
        return HttpDecider(PUBLIC_DECIDER_URL)
    if backend == "http":
        return HttpDecider(os.environ.get("EGGHEAD_DECIDER_URL", "http://127.0.0.1:8000"))
    if backend == "local":
        return LocalDecider(
            os.environ.get("EGGHEAD_DECIDER_CHECKPOINT", DEFAULT_MODEL),
            os.environ.get("EGGHEAD_DECIDER_DEVICE", "cpu"),
        )
    raise ValueError(f"unknown EGGHEAD_DECIDER_BACKEND: {backend}")
