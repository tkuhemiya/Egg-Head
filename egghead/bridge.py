"""Text-mode loop: utterance in, decision record out. Every decision is kept for the dashboard.

hear():  ask Decider once per utterance -> route -> run the check -> compare in code ->
         ledger -> gate -> maybe speak. Silence ticks reuse the gate without a new utterance.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from . import gate as G
from .checks import CheckSource
from .compare import compare, infer_asserted
from .decider import Decider
from .ledger import Ledger, LedgerItem
from .questions import POLICY, build_questions, render_state
from .router import Route, route
from .speaker import Writer, template_line

WINDOW_TURNS = 12  # rolling window; the model context is 4,096 tokens


@dataclass
class Event:
    turn: int
    speaker: str
    text: str
    decider_ms: float = 0.0
    route: Route | None = None
    verdict: str | None = None
    check_evidence: str | None = None
    gate: G.GateDecision | None = None
    said: str | None = None
    escalations: int = 0


@dataclass
class Bridge:
    decider: Decider
    source: CheckSource
    writer: Writer = template_line
    ledger: Ledger = field(default_factory=Ledger)
    turns: list[tuple[str, str]] = field(default_factory=list)
    events: list[Event] = field(default_factory=list)
    escalations: int = 0
    _last_spoke: float = float("-inf")
    _answers: dict = field(default_factory=dict)

    def hear(self, speaker: str, text: str, silence_s: float = 0.0) -> Event:
        self.turns.append((speaker, text))
        window = self.turns[-WINDOW_TURNS:]
        open_items = self.ledger.open()
        qs = build_questions(self.source.resources(), with_policy=bool(open_items))
        t = time.perf_counter()
        answers = self.decider.ask(render_state(window, open_items), qs)
        ev = Event(len(self.turns) - 1, speaker, text,
                   decider_ms=(time.perf_counter() - t) * 1000)
        self._answers = answers

        rt = route(answers)
        ev.route = rt
        if rt.action == "escalate":
            self.escalations += 1
            ev.escalations = self.escalations
        supports_open = False
        if rt.action == "check":
            res = self.source.run(rt.check, rt.resource)
            if res:
                asserted = rt.asserted if rt.asserted != "unclear" else infer_asserted(text)
                ev.verdict = compare(asserted, res.status)
                ev.check_evidence = res.evidence
                if ev.verdict == "contradicts":
                    self.ledger.add(LedgerItem(speaker, text, rt.check, rt.resource, res.status,
                                               res.evidence, turn=ev.turn))
                elif ev.verdict == "supports":
                    supports_open = any(i.check == rt.check and i.resource == rt.resource
                                        for i in open_items)
        self._decide(ev, silence_s, supports_open)
        self.events.append(ev)
        return ev

    def tick(self, silence_s: float) -> Event | None:
        """More silence with no new utterance (from VAD). Re-runs the gate on the last answers."""
        if not self.ledger.open() or not self.events:
            return None
        ev = Event(len(self.turns) - 1, "(silence)", "")
        self._decide(ev, silence_s, supports_open=False)
        self.events.append(ev)
        return ev

    def _decide(self, ev: Event, silence_s: float, supports_open: bool) -> None:
        open_items = self.ledger.open()
        if not open_items:
            return
        item = open_items[0]
        a = self._answers
        if all(q in a for q in POLICY):
            self_rep, interrupt = a["self_repaired"]["noul"], a["floor_free"]["noul"]
        else:  # claim was just added this turn; policy questions were not asked yet
            self_rep, interrupt = 0.0, 0.5
        g = G.GateInput(
            check=item.check, status=item.status,
            later_turns=[text for _, text in self.turns[item.turn + 1:]],
            silence_s=silence_s, self_repaired_p=self_rep, interrupt_p=interrupt,
            later_claim_supports_check=supports_open,
            seconds_since_last_spoke=time.monotonic() - self._last_spoke,
        )
        ev.gate = G.decide(g)
        if ev.gate.speak:
            item.raised = True
            self._last_spoke = time.monotonic()
            ev.said = self.writer(item)
        elif ev.gate.repaired_by:
            item.raised = True  # corrected by the call itself: close it, stay silent
