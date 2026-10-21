"""Claim vs check result, in code: supports / contradicts / inconclusive."""

from __future__ import annotations

BAD = {"degraded", "down"}


def compare(asserted: str | None, status: str | None) -> str:
    if asserted in (None, "unclear") or status is None:
        return "inconclusive"
    if asserted == "healthy":
        return "contradicts" if status in BAD else "supports"
    if asserted in BAD:
        return "contradicts" if status == "healthy" else "supports"
    if asserted in ("changed", "unchanged"):
        if status not in ("changed", "unchanged"):
            return "inconclusive"
        return "supports" if asserted == status else "contradicts"
    return "inconclusive"


# Decider answered `unclear` on 10 of 25 pass-2 asserted_state cases, so when it does, fall
# back to the plain wording of the utterance. Order matters: "didn't deploy" before "deploy".
_FALLBACK = [
    ("unchanged", r"\b(?:didn'?t|did not|haven'?t|have not|no|nothing)\b.*\b(?:deploy|release|chang)"),
    ("changed", r"\b(?:deployed|released|rolled out|pushed|changed)\b"),
    ("healthy", r"\b(?:fine|normal|healthy|green|ok(?:ay)?|stable|not the problem|no alarms)\b"),
    ("down", r"\b(?:completely down|is down|unreachable)\b"),
    ("degraded", r"\b(?:slow|spik\w+|erroring|elevated|backed up|struggling|high)\b"),
]


def infer_asserted(text: str) -> str:
    import re

    for state, pattern in _FALLBACK:
        if re.search(pattern, text, re.IGNORECASE):
            return state
    return "unclear"
