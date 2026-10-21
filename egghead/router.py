"""ClaimCheckRouter: Decider routing answers -> which check to run, on what, for what claim."""

from __future__ import annotations

from dataclasses import dataclass

from .checks import NONE_CHECK, UNKNOWN_RESOURCE

T_ROUTE = 0.7        # fire the check at or above this (100% precision on pass 2)
T_ESCALATE = 0.55    # between this and T_ROUTE, hand the decision to Bedrock (counted)


@dataclass
class Route:
    action: str                   # "check" | "escalate" | "ignore"
    check: str | None
    resource: str | None
    asserted: str | None
    scores: dict[str, float]


def _conf(ans: dict) -> float:
    return float(ans["confidence"])


def route(answers: dict) -> Route:
    scores = {
        "is_claim": answers["is_claim"]["noul"],
        "which_check": _conf(answers["which_check"]),
        "which_resource": _conf(answers["which_resource"]),
    }
    check = answers["which_check"]["choice"]
    resource = answers["which_resource"]["choice"]
    asserted = answers["asserted_state"]["choice"]
    resolvable = check != NONE_CHECK and resource != UNKNOWN_RESOURCE
    lowest = min(scores.values())
    if resolvable and lowest >= T_ROUTE:
        action = "check"
    elif resolvable and lowest >= T_ESCALATE:
        action = "escalate"
    else:
        action = "ignore"
    return Route(action, check if resolvable else None, resource if resolvable else None,
                 asserted, scores)
