"""Decider question set for the go/no-go spike (PROJECT.md §5).

Everything here is shared by run.py and eval.py: the check registry, the
option sets, how a snippet is rendered into one Decider state, the gate, and
the claim/check comparison. Edit wording here, then re-run.
"""

from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).parent
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

# Gate thresholds (PROJECT.md §5.3). Starting points; the spike calibrates them.
T_ROUTE = 0.9          # is_claim probability and choice confidence to run a check
T_SELF_REPAIRED = 0.3  # speak only if P(self_repaired) below this
T_FLOOR = 0.7          # floor_free probability, or ...
T_SILENCE_S = 1.2      # ... this much silence from VAD
T_COST = 2.0           # E[silence_cost] index >= "moderate"


def load_world() -> dict:
    return json.loads((HERE / "world.json").read_text())


def inventory(world: dict) -> dict[str, str]:
    """Resource options, built from the live inventory, plus `unknown`."""
    opts = dict(world["resources"])
    opts["unknown"] = "unknown: it is unclear which single resource is meant, or it is several / none"
    return opts


def render_state(snippet: dict) -> str:
    """One Decider state per snippet: transcript window, latest marked, open ledger."""
    lines = ["Incident bridge call transcript (oldest first)."]
    turns = snippet["transcript"]
    for i, t in enumerate(turns):
        mark = ">>> LATEST " if i == len(turns) - 1 else ""
        lines.append(f'{mark}{t["speaker"]}: {t["text"]}')
    lines.append("")
    if snippet.get("ledger"):
        lines.append("Flagged claim (checked by Egg Head, not yet raised on the call):")
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
            "instructions": "Does the latest utterance assert something about the current state "
            "of a system, service, metric or recent change?",
        },
        "which_check": {
            "type": "choice",
            "instructions": "Which check would verify the latest utterance?",
            "criteria": CHECKS,
        },
        "which_resource": {
            "type": "choice",
            "instructions": "Which resource is the latest utterance about?",
            "criteria": inventory(world),
        },
        "asserted_state": {
            "type": "choice",
            "instructions": "What does the speaker of the latest utterance claim about it?",
            "criteria": ASSERTED,
        },
        "self_repaired": {
            "type": "noul",
            "instructions": "Since the flagged claim was made, has anyone on the call already "
            "corrected or questioned it?",
        },
        "open_question": {
            "type": "noul",
            "instructions": "Is there a question in the recent conversation that nobody has answered?",
        },
        "floor_free": {
            "type": "noul",
            "instructions": "Is this a natural moment to interject, rather than mid-thought or "
            "mid-argument?",
        },
        "silence_cost": {
            "type": "score",
            "instructions": "How harmful would it be for the team to keep going without being told "
            "the flagged check result?",
            "criteria": SILENCE_COST,
        },
    }


# Alternate wordings for the rewording test (run.py --reword).
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
    """PROJECT.md §5.3 'run check' rule over Decider answers."""
    return (
        a["is_claim"]["noul"] >= T_ROUTE
        and a["which_check"]["choice"] != "none"
        and choice_conf(a["which_check"]) >= T_ROUTE
        and a["which_resource"]["choice"] != "unknown"
        and choice_conf(a["which_resource"]) >= T_ROUTE
    )


def speak_gate(a: dict, silence_s: float, cooldown_ok: bool = True) -> bool:
    """PROJECT.md §5.3 'speak' rule for an open, already-persisted contradiction."""
    return (
        a["self_repaired"]["noul"] < T_SELF_REPAIRED
        and (a["floor_free"]["noul"] >= T_FLOOR or silence_s >= T_SILENCE_S)
        and a["silence_cost"]["score"] >= T_COST
        and cooldown_ok
    )
