"""SpeakGate: should Egg Head interrupt the call with a contradicted claim?

Pass-2 spike findings (spike/out/pass2/REPORT.md) decide who owns what:

- `floor_free` (asked as "would speaking interrupt?" and inverted) was 87% accurate, but it
  missed the cases where someone was still mid-thought. Decider stays the gap detector and
  code adds a hard minimum of VAD silence.
- `self_repaired` was 69% and overlapped too much to threshold. Repair is now keyword
  overlay on the turns after the claim, or a later true claim for the same resource
  (from the ClaimCheckRouter). The Decider answer stays as a weak third vote.
- `silence_cost` was 12% and sat near 0.4 on every snippet. Cost is now derived from the
  check that disagreed, and drops when the call parked the topic.

All of it is plain code over the Decider probabilities, so each decision can be shown on
the dashboard with the reason it was made.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

LEVELS = ["none", "low", "moderate", "high", "critical"]

T_SELF_REPAIRED = 0.45   # Decider vote only; the keyword and ledger signals decide most cases
T_FLOOR = 0.5            # P(natural gap) after inverting the interrupt question
T_MIN_SILENCE_S = 0.5    # never speak over a live voice, whatever the Decider says
T_SILENCE_S = 1.2        # this much silence opens the gate on its own
T_COST_LEVEL = 2         # moderate: do not interrupt for less
COOLDOWN_S = 30.0

# Base cost of staying silent per check type: how much a wrong belief about it misdirects
# an incident (deploys and databases are the usual wrong turns; an alarm list is context).
BASE_COST = {
    "db_health": 3,
    "service_error_rate": 3,
    "recent_deploys": 3,
    "queue_depth": 3,
    "latency_p99": 2,
    "alarm_state": 2,
}
DOWN_BUMP = 1  # a check that says "down" is worse than "degraded"

REPAIR_PATTERNS = [
    r"\bwait\b", r"\bhold on\b", r"\bare you sure\b", r"\bhow sure\b",
    r"\bI was (?:looking|wrong)\b", r"\bthat'?s not (?:right|true)\b", r"\bactually\b",
]
PARKED_PATTERNS = [
    r"\bpark(?:ed|ing)?\b", r"\bnot in the (?:\w+ )?path\b", r"\bset (?:that|it) aside\b",
    r"\bstay on\b", r"\bback to that later\b",
]
_REPAIR = re.compile("|".join(REPAIR_PATTERNS), re.IGNORECASE)
_PARKED = re.compile("|".join(PARKED_PATTERNS), re.IGNORECASE)


@dataclass
class GateInput:
    check: str
    status: str                       # live check status for the flagged claim
    later_turns: list[str]            # utterance text after the flagged claim, oldest first
    silence_s: float                  # VAD silence since the last voice
    self_repaired_p: float            # Decider noul, P(someone already corrected it)
    interrupt_p: float                # Decider noul, P(speaking now would interrupt)
    later_claim_supports_check: bool = False  # router found a later true claim on this resource
    seconds_since_last_spoke: float = float("inf")


@dataclass
class GateDecision:
    speak: bool
    blocked_by: str | None
    repaired_by: str | None
    cost_level: int
    floor_p: float
    reasons: dict[str, bool] = field(default_factory=dict)


def repaired_by(g: GateInput) -> str | None:
    """Why this claim no longer needs raising, or None."""
    if g.later_claim_supports_check:
        return "ledger"
    if any(_REPAIR.search(t) for t in g.later_turns):
        return "keyword"
    if g.self_repaired_p >= T_SELF_REPAIRED:
        return "decider"
    return None


def cost_level(g: GateInput) -> int:
    """How harmful silence is, from the check that disagreed. 0 none ... 4 critical."""
    if any(_PARKED.search(t) for t in g.later_turns):
        return 1
    level = BASE_COST.get(g.check, 2)
    if g.status == "down":
        level += DOWN_BUMP
    return min(level, len(LEVELS) - 1)


def decide(g: GateInput) -> GateDecision:
    floor_p = 1 - g.interrupt_p
    rep = repaired_by(g)
    level = cost_level(g)
    reasons = {
        "persisted": bool(g.later_turns),  # the call has moved on at least one turn since the claim
        "not_repaired": rep is None,
        "min_silence": g.silence_s >= T_MIN_SILENCE_S,
        "floor_open": floor_p >= T_FLOOR or g.silence_s >= T_SILENCE_S,
        "worth_it": level >= T_COST_LEVEL,
        "cooldown": g.seconds_since_last_spoke >= COOLDOWN_S,
    }
    blocked = next((k for k, ok in reasons.items() if not ok), None)
    return GateDecision(speak=blocked is None, blocked_by=blocked, repaired_by=rep,
                        cost_level=level, floor_p=floor_p, reasons=reasons)
