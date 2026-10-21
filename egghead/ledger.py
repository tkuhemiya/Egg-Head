"""Claim ledger: checked claims that contradict a live check and have not been raised yet."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class LedgerItem:
    speaker: str
    claim: str
    check: str
    resource: str
    status: str          # what the check returned: healthy / degraded / down / changed / unchanged
    evidence: str
    turn: int = 0        # index of the claim in the transcript
    raised: bool = False


@dataclass
class Ledger:
    items: list[LedgerItem] = field(default_factory=list)

    def add(self, item: LedgerItem) -> bool:
        """Add a contradicted claim. Returns False when the same check+resource is already open."""
        if any(i.check == item.check and i.resource == item.resource and not i.raised
               for i in self.items):
            return False
        self.items.append(item)
        return True

    def open(self) -> list[LedgerItem]:
        return [i for i in self.items if not i.raised]
