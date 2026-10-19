"""Decider backends: a running `strands-decider serve`, an in-process engine, or replayed answers."""

from __future__ import annotations

import json
import urllib.request
from typing import Protocol

DEFAULT_MODEL = "StrandsAgents/strands-decider-2B-qwen3.5-v1-2610"


class Decider(Protocol):
    def ask(self, state: str, questions: dict) -> dict:
        """One batch against one state -> {question id: answer}."""


class HttpDecider:
    def __init__(self, url: str = "http://127.0.0.1:8000"):
        self.url = url.rstrip("/")

    def ask(self, state: str, questions: dict) -> dict:
        body = json.dumps({"state": state, "questions": questions}).encode()
        req = urllib.request.Request(self.url + "/v1/systemone", body,
                                     {"content-type": "application/json"})
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
