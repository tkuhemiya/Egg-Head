"""Turn a contradicted claim into one short, evidence-backed sentence.

`template_line` is the offline default so the loop runs without AWS credentials. A Bedrock
writer slots in behind the same signature once the Strands `Deny` behaviour is confirmed.
"""

from __future__ import annotations

from typing import Callable

from .ledger import LedgerItem

Writer = Callable[[LedgerItem], str]


def template_line(item: LedgerItem) -> str:
    return f"Quick flag on {item.speaker}'s point: {item.resource} {item.evidence}."
