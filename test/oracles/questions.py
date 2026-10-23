"""Decider question set from the Day-1 go/no-go spike (pass 2), frozen.

The pass-2 run that produced out/results.jsonl used these questions. Kept for
gate_eval.py and export_gate_parity.py: the check registry, the pass-2 gates and
the claim/check comparison. The harness that asked them (run.py, eval.py) is in
git history.
"""

from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).parent
ROOT = HERE.parent.parent
# The labelled snippets and the check world live with the rest of the data.
DATASET = ROOT / "docs/research/decider/data/source/egghead_spike.jsonl"
WORLD = ROOT / "data/world.json"
DEFAULT_MODEL = "StrandsAgents/strands-decider-2B-qwen3.5-v1-2610"

# Check registry: name -> one-line description (the Decider option label).
CHECKS = {
    "db_health": "Database health: CPU, connections and alarm state for a database",
    "service_error_rate": "Error rate (5xx) of a service or API, including whether it is up or down",
    "latency_p99": "Latency / response time (p99) of a service or API",
    "recent_deploys": "Recent deploys, releases or config changes to a service",
    "alarm_state": "Which CloudWatch alarms are currently firing",
    "queue_depth": "Backlog / number of waiting messages in a queue",
    "none": "None of these: the utterance cannot be verified by any check",
}

ASSERTED = {
    "healthy": "The speaker says it is fine, normal, working or not the problem",
    "degraded": "The speaker says it is slow, erroring, elevated, backed up or struggling",
    "down": "The speaker says it is completely down or unreachable",
    "changed": "The speaker says something was deployed, released or changed",
    "unchanged": "The speaker says nothing was deployed, released or changed",
    "unclear": "The speaker does not say what state it is in",
}

SILENCE_COST = ["none", "low", "moderate", "high", "critical"]

# Gate thresholds. Pass 1 (the original design's 0.9 starting points) never fired: noul
# answers sat in 0.5–0.8, so conf ≥ 0.9 had ~0% coverage. Pass 2 uses the
# calibration from pass 1 (routing precision was 100% at T=0.7).
T_ROUTE = 0.7          # is_claim probability and choice confidence to run a check
T_SELF_REPAIRED = 0.45 # speak only if P(self_repaired) below this
T_FLOOR = 0.5          # P(floor is free) after inverting the interrupt question
T_SILENCE_S = 1.2      # ... or this much silence from VAD
T_COST = 0.5           # noul: worth interrupting? (pass 1 5-level score always ~2)
# floor_free is asked as "would speaking interrupt?" — invert so True = gap.
FLOOR_INVERT = True
# Dataset silence_cost is still 0–4; the noul gold is "at least moderate".
SILENCE_COST_NOUL_AT = 2


def load_world() -> dict:
    return json.loads(WORLD.read_text())


def inventory(world: dict) -> dict[str, str]:
    """Resource options, built from the live inventory, plus `unknown`."""
    opts = dict(world["resources"])
    opts["unknown"] = "unknown: it is unclear which single resource is meant, or it is several / none"
    return opts


def render_state(snippet: dict) -> str:
    """One Decider state per snippet: transcript window, latest marked, open ledger."""
    lines = [
        "Incident bridge call transcript (oldest first).",
        "Routing questions (is_claim, which_check, which_resource, asserted_state) "
        "apply ONLY to the utterance marked LATEST, not to the flagged claim.",
    ]
    turns = snippet["transcript"]
    for i, t in enumerate(turns):
        mark = ">>> LATEST " if i == len(turns) - 1 else ""
        lines.append(f'{mark}{t["speaker"]}: {t["text"]}')
    lines.append("")
    if snippet.get("ledger"):
        lines.append("Flagged claim (already checked by Egg Head, not yet raised on the call). "
                     "Use this only for self_repaired, open_question, floor_free, silence_cost:")
        for item in snippet["ledger"]:
            lines.append(
                f'- {item["speaker"]} said "{item["claim"]}". '
                f'Check {item["check"]} on {item["resource"]}: {item["evidence"]}.'
            )
    else:
        lines.append("Flagged claim: none.")
    return "\n".join(lines)


# The batch asked for every snippet. id -> API question body.
def build_questions(world: dict) -> dict[str, dict]:
    return {
        "is_claim": {
            "type": "noul",
            "instructions": "Is the LATEST utterance a factual statement about how a system is "
            "behaving right now, or about a recent deploy or change? Guesses, questions, plans, "
            "actions, and statements about the past are not. Ignore the flagged claim.",
        },
        "which_check": {
            "type": "choice",
            "instructions": "Which one check would verify the LATEST utterance? If that utterance "
            "is not a checkable claim, choose none. Ignore the flagged claim.",
            "criteria": CHECKS,
        },
        "which_resource": {
            "type": "choice",
            "instructions": "Which single named resource does the LATEST utterance refer to? "
            "Use earlier turns to resolve words like 'it' or 'the database'. If it is unclear, "
            "several, or none, choose unknown. Ignore the flagged claim.",
            "criteria": inventory(world),
        },
        "asserted_state": {
            "type": "choice",
            "instructions": "What does the speaker of the LATEST utterance claim about that "
            "resource? Ignore the flagged claim.",
            "criteria": ASSERTED,
        },
        "self_repaired": {
            "type": "noul",
            "instructions": "After the flagged claim, did someone on the call already say it was "
            "wrong, or ask whether it was right? Agreeing with the claim is not a correction.",
        },
        "open_question": {
            "type": "noul",
            "instructions": "Did someone ask a question in the recent conversation that is still "
            "waiting for an answer?",
        },
        "floor_free": {
            "type": "noul",
            # Asked as the interrupt question (pass-1 v1, 87% after invert). Gate inverts it.
            "instructions": "Would speaking right now interrupt someone in the middle of a "
            "sentence or an argument?",
        },
        "silence_cost": {
            "type": "noul",
            "instructions": "Is the flagged check result important enough to interrupt the team "
            "with, given what they are currently discussing? Parked or off-path topics are not.",
        },
    }


# Alternate wordings for the pass-1 rewording test.
VARIANTS = {
    "is_claim": [
        "Is the latest utterance a factual statement about how a system is behaving right now, "
        "or about a recent deploy or change? Guesses, questions, plans and actions are not.",
        "Could the latest utterance be proven true or false by looking at monitoring data or "
        "deploy history?",
    ],
    "which_check": [
        "To find out whether the latest utterance is true, which one check should be run?",
        "Which monitoring check is the latest utterance about?",
    ],
    "which_resource": [
        "Which single named resource does the latest utterance refer to? Use the earlier "
        "conversation to resolve words like 'it' or 'the database'.",
        "The latest utterance is about which service, database or queue?",
    ],
    "asserted_state": [
        "According to the speaker of the latest utterance, what state is the resource in?",
    ],
    "self_repaired": [
        "After the flagged claim, did someone else on the call already say it was wrong, "
        "or ask whether it was right?",
        "Has the team already noticed the flagged claim may be wrong?",
    ],
    "open_question": [
        "Did someone ask a question in the recent conversation that is still waiting for an answer?",
    ],
    "floor_free": [
        "Has the latest speaker finished their thought, so that someone else could naturally "
        "speak now without interrupting?",
        "Would speaking right now interrupt someone in the middle of a sentence or an argument?",
    ],
    "silence_cost": [
        "If nobody tells the team the flagged check result, how much would it hurt the incident "
        "response?",
    ],
}
# Variants whose meaning is inverted relative to the base question.
INVERTED = {("floor_free", 1)}


def compare(asserted: str | None, status: str | None) -> str:
    """Claim vs check result, in code: supports / contradicts / inconclusive."""
    if asserted in (None, "unclear") or status is None:
        return "inconclusive"
    bad = {"degraded", "down"}
    if asserted == "healthy":
        return "contradicts" if status in bad else "supports"
    if asserted in bad:
        return "contradicts" if status == "healthy" else "supports"
    if asserted in ("changed", "unchanged"):
        if status not in ("changed", "unchanged"):
            return "inconclusive"
        return "supports" if asserted == status else "contradicts"
    return "inconclusive"


def lookup(world: dict, resource: str | None, check: str | None) -> dict | None:
    return world["checks"].get(resource or "", {}).get(check or "")


def choice_conf(ans: dict) -> float:
    return float(ans["confidence"])


def route_gate(a: dict) -> bool:
    """The spike's 'run check' rule over Decider answers."""
    return (
        a["is_claim"]["noul"] >= T_ROUTE
        and a["which_check"]["choice"] != "none"
        and choice_conf(a["which_check"]) >= T_ROUTE
        and a["which_resource"]["choice"] != "unknown"
        and choice_conf(a["which_resource"]) >= T_ROUTE
    )


def floor_free_p(a: dict) -> float:
    """P(natural gap). Pass 2 asks the interrupt question and inverts."""
    p = a["floor_free"]["noul"]
    return 1 - p if FLOOR_INVERT else p


def silence_cost_p(a: dict) -> float:
    """P(worth interrupting). Pass 1 was a 5-level score; pass 2 is noul."""
    if a["silence_cost"]["type"] == "noul":
        return a["silence_cost"]["noul"]
    return a["silence_cost"]["score"] / (len(SILENCE_COST) - 1)


def speak_gate(a: dict, silence_s: float, cooldown_ok: bool = True) -> bool:
    """The spike's 'speak' rule for an open, already-persisted contradiction."""
    return (
        a["self_repaired"]["noul"] < T_SELF_REPAIRED
        and (floor_free_p(a) >= T_FLOOR or silence_s >= T_SILENCE_S)
        and silence_cost_p(a) >= T_COST
        and cooldown_ok
    )
