"""Decider questions (pass-2 wording from the spike) and the state they read.

Routing questions apply only to the LATEST utterance. Policy questions read the flagged
claim from the ledger. Do not reword without re-running spike/run.py: pass 1 showed small
wording changes move accuracy a lot.
"""

from __future__ import annotations

from .checks import (CHECKS, NONE_CHECK, NONE_DESCRIPTION, UNKNOWN_DESCRIPTION,
                     UNKNOWN_RESOURCE)
from .ledger import LedgerItem

ASSERTED = {
    "healthy": "The speaker says it is fine, normal, working or not the problem",
    "degraded": "The speaker says it is slow, erroring, elevated, backed up or struggling",
    "down": "The speaker says it is completely down or unreachable",
    "changed": "The speaker says something was deployed, released or changed",
    "unchanged": "The speaker says nothing was deployed, released or changed",
    "unclear": "The speaker does not say what state it is in",
}

ROUTING = ("is_claim", "which_check", "which_resource", "asserted_state")
POLICY = ("self_repaired", "open_question", "floor_free")


def render_state(turns: list[tuple[str, str]], open_items: list[LedgerItem]) -> str:
    lines = [
        "Incident bridge call transcript (oldest first).",
        "Routing questions (is_claim, which_check, which_resource, asserted_state) "
        "apply ONLY to the utterance marked LATEST, not to the flagged claim.",
    ]
    for i, (speaker, text) in enumerate(turns):
        mark = ">>> LATEST " if i == len(turns) - 1 else ""
        lines.append(f"{mark}{speaker}: {text}")
    lines.append("")
    if open_items:
        lines.append("Flagged claim (already checked by Egg Head, not yet raised on the call). "
                     "Use this only for self_repaired, open_question, floor_free:")
        for it in open_items:
            lines.append(f'- {it.speaker} said "{it.claim}". Check {it.check} on {it.resource}: '
                         f"{it.evidence}.")
    else:
        lines.append("Flagged claim: none.")
    return "\n".join(lines)


def build_questions(resources: dict[str, str], with_policy: bool) -> dict[str, dict]:
    qs = {
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
            "criteria": {**CHECKS, NONE_CHECK: NONE_DESCRIPTION},
        },
        "which_resource": {
            "type": "choice",
            "instructions": "Which single named resource does the LATEST utterance refer to? "
            "Use earlier turns to resolve words like 'it' or 'the database'. If it is unclear, "
            "several, or none, choose unknown. Ignore the flagged claim.",
            "criteria": {**resources, UNKNOWN_RESOURCE: UNKNOWN_DESCRIPTION},
        },
        "asserted_state": {
            "type": "choice",
            "instructions": "What does the speaker of the LATEST utterance claim about that "
            "resource? Ignore the flagged claim.",
            "criteria": ASSERTED,
        },
    }
    if with_policy:
        qs |= {
            "self_repaired": {
                "type": "noul",
                "instructions": "After the flagged claim, did someone on the call already say it "
                "was wrong, or ask whether it was right? Agreeing with the claim is not a "
                "correction.",
            },
            "open_question": {
                "type": "noul",
                "instructions": "Did someone ask a question in the recent conversation that is "
                "still waiting for an answer?",
            },
            "floor_free": {
                # Asked as the interrupt question (87% after inverting). Callers invert it.
                "type": "noul",
                "instructions": "Would speaking right now interrupt someone in the middle of a "
                "sentence or an argument?",
            },
        }
    return qs
