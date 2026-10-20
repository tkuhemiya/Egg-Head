"""Amazon Bedrock side of Egg Head, through a Strands agent.

Bedrock does two jobs, and only when Decider and the gate hand it one:

- Tool-calling agent: when the gate opens, the agent gets the contradicted claim and the
  registered checks as tools. It can re-run a check or read a related one, then writes the
  one spoken sentence from what the tools returned.
- Support during the call: when routing lands in the mid-confidence band (router.T_ESCALATE
  to T_ROUTE), the agent picks the check and resource for that one utterance. Each call is
  counted by the Bridge.

`Deny` in `before_model_call` was checked in the Strands source: it sets `event.cancel`, the
event loop skips the model entirely and returns an assistant message "DENIED: <reason>" with
stop_reason end_turn and zero usage, so a closed gate costs no Bedrock call.

Nothing here runs without AWS credentials; `SpeakGuard` and the prompts are tested with
stubs. Set EGGHEAD_MODEL_ID (and AWS_REGION) to pick the Bedrock model.
"""

from __future__ import annotations

import os
from typing import Callable

from pydantic import BaseModel
from strands import Agent, tool
from strands.interventions.actions import Deny, Proceed
from strands.interventions.handler import InterventionHandler

from .checks import CHECKS, CheckSource
from .ledger import LedgerItem
from .router import Route

WRITER_PROMPT = (
    "You are Egg Head, a quiet teammate on an incident bridge call. A claim someone made was "
    "contradicted by a live check. Say it in ONE spoken sentence of at most 25 words, plain "
    "words, start with 'Quick flag', cite the numbers from the evidence, no markdown. You may "
    "call run_check once to confirm or to read a related check. Never invent numbers."
)
ESCALATE_PROMPT = (
    "You help Egg Head decide which live check can verify the LATEST utterance on an "
    "incident call. Pick the one check and the one resource, and the state the speaker "
    "asserts. If it cannot be verified by any check, say it is not checkable."
)


class RouteChoice(BaseModel):
    checkable: bool
    check: str | None = None
    resource: str | None = None
    asserted: str | None = None  # healthy / degraded / down / changed / unchanged


class SpeakGuard(InterventionHandler):
    """Closed gate => `Deny`, so silence never reaches Bedrock.

    `gate_open` returns None when the gate is open, else the reason it is closed.
    """

    name = "egghead-speak-guard"

    def __init__(self, gate_open: Callable[[], str | None]):
        self._gate_open = gate_open

    def before_model_call(self, event, **kwargs):
        reason = self._gate_open()
        return Deny(reason=reason) if reason else Proceed()


def check_tool(source: CheckSource):
    @tool
    def run_check(check: str, resource: str) -> str:
        """Run a live check. check is one of the registered checks, resource a known resource."""
        res = source.run(check, resource)
        if res is None:
            return f"{check} does not apply to {resource}"
        return f"{res.check} on {res.resource}: {res.status}. {res.evidence}"

    return run_check


def _model():
    from strands.models import BedrockModel

    model_id = os.environ.get("EGGHEAD_MODEL_ID")
    return BedrockModel(model_id=model_id) if model_id else BedrockModel()


class BedrockSupport:
    """Writer and mid-band router. `agent_factory` is injectable so tests need no AWS."""

    def __init__(self, source: CheckSource, agent_factory: Callable[..., Agent] | None = None,
                 guard: SpeakGuard | None = None):
        self.source = source
        self.guard = guard
        self._factory = agent_factory or self._default_factory
        self.calls = {"write": 0, "route": 0}

    def _default_factory(self, system_prompt: str, tools: list, handlers: list) -> Agent:
        return Agent(model=_model(), system_prompt=system_prompt, tools=tools,
                     interventions=handlers, callback_handler=None)

    def write(self, item: LedgerItem) -> str:
        agent = self._factory(WRITER_PROMPT, [check_tool(self.source)],
                              [self.guard] if self.guard else [])
        self.calls["write"] += 1
        prompt = (f'{item.speaker} said "{item.claim}". Check {item.check} on {item.resource} '
                  f"returned {item.status}: {item.evidence}.")
        return str(agent(prompt)).strip()

    def route(self, turns: list[tuple[str, str]]) -> Route:
        agent = self._factory(ESCALATE_PROMPT, [], [])
        self.calls["route"] += 1
        known = "\n".join(f"- {n}: {d}" for n, d in self.source.resources().items())
        checks = "\n".join(f"- {n}: {d}" for n, d in CHECKS.items())
        talk = "\n".join(f"{s}: {t}" for s, t in turns[-6:])
        out = agent(f"Checks:\n{checks}\n\nResources:\n{known}\n\nCall so far (last line is "
                    f"LATEST):\n{talk}", structured_output_model=RouteChoice)
        choice: RouteChoice = out.structured_output
        if not (choice.checkable and choice.check in CHECKS
                and choice.resource in self.source.resources()):
            return Route("ignore", None, None, None, {})
        return Route("check", choice.check, choice.resource, choice.asserted,
                     {"bedrock": 1.0})
