"""Check registry and check sources.

A check is a named question about live infrastructure with a one-line description. The
description is the Decider option label, so write it as what the check can verify. Sources
answer a (check, resource) pair: `MockSource` replays a scripted world with fault injection
for the local demo, and an AWS source can implement the same two methods later.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

DATA = Path(__file__).parent / "data"

# check name -> description (the Decider option label).
CHECKS = {
    "db_health": "Database health: CPU, connections and alarm state for a database",
    "service_error_rate": "Error rate (5xx) of a service or API, including whether it is up or down",
    "latency_p99": "Latency / response time (p99) of a service or API",
    "recent_deploys": "Recent deploys, releases or config changes to a service",
    "alarm_state": "Which CloudWatch alarms are currently firing",
    "queue_depth": "Backlog / number of waiting messages in a queue",
}
NONE_CHECK = "none"
NONE_DESCRIPTION = "None of these: the utterance cannot be verified by any check"
UNKNOWN_RESOURCE = "unknown"
UNKNOWN_DESCRIPTION = "unknown: it is unclear which single resource is meant, or it is several / none"


@dataclass(frozen=True)
class CheckResult:
    check: str
    resource: str
    status: str      # healthy / degraded / down / changed / unchanged
    evidence: str


class CheckSource(Protocol):
    def resources(self) -> dict[str, str]:
        """Resource name -> one-line description, built from the live inventory."""

    def run(self, check: str, resource: str) -> CheckResult | None:
        """Run a check. None when that check does not apply to that resource."""


class MockSource:
    """Scripted world for the local demo. `inject` flips a resource into a fault."""

    def __init__(self, world: dict):
        self._resources = dict(world["resources"])
        self._checks = {r: {c: dict(v) for c, v in cs.items()} for r, cs in world["checks"].items()}

    @classmethod
    def load(cls, path: Path | None = None) -> "MockSource":
        return cls(json.loads((path or DATA / "world.json").read_text()))

    def resources(self) -> dict[str, str]:
        return dict(self._resources)

    def run(self, check: str, resource: str) -> CheckResult | None:
        hit = self._checks.get(resource, {}).get(check)
        return CheckResult(check, resource, hit["status"], hit["evidence"]) if hit else None

    def inject(self, resource: str, check: str, status: str, evidence: str) -> None:
        self._checks.setdefault(resource, {})[check] = {"status": status, "evidence": evidence}
