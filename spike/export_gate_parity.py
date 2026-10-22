"""Export golden speak-gate decisions from the frozen Python gate for the TypeScript parity test.

Two sets go into test/fixtures/gate-parity.json:

- `pass2`: the 16 spike snippets with an open flagged claim, built exactly as gate_eval.py
  builds them from the saved pass-2 Decider answers. These rows reproduce REPORT-gate.md.
- `grid`: a combinatorial sweep over every gate input (checks, statuses, repair and parked
  wording, silence, Decider votes, ledger support, cooldown) so each branch is covered. The
  axes are stored once and each row holds only the outputs, in itertools.product order.

Run from the repo root: python3 spike/export_gate_parity.py
"""

from __future__ import annotations

import itertools
import json
from dataclasses import asdict
from pathlib import Path

import egghead_gate as G
import gate_eval
import questions as Q

OUT = Path(__file__).resolve().parent.parent / "test" / "fixtures" / "gate-parity.json"

LATER = [
    [],
    ["Okay, let's focus on the API."],
    ["Agreed, DB looks okay from here too."],
    ["Wait Sam, orders-db is at 98"],
    ["Sam, how sure are you?"],
    ["That's not right, I was looking at the graph."],
    ["Auth isn't in the checkout path, let's park that."],
    ["Let's stay on payments.", "Actually, can we look at the queue?"],
]


def row(g: G.GateInput) -> dict:
    d = G.decide(g)
    inp = asdict(g)
    if inp["seconds_since_last_spoke"] == float("inf"):
        inp["seconds_since_last_spoke"] = None  # JSON has no Infinity; the TS side maps null back
    return {"input": inp, "decision": asdict(d)}


def pass2() -> list[dict]:
    snips = [json.loads(l) for l in Q.DATASET.read_text().splitlines() if l]
    results = {json.loads(l)["id"]: json.loads(l)
               for l in (Q.HERE / "out/results.jsonl").read_text().splitlines() if l}
    rows = []
    for s in snips:
        if not s["ledger"] or s["id"] not in results:
            continue
        r = row(gate_eval.gate_input(s, results[s["id"]]["answers"]))
        rows.append({"id": s["id"], "gold": s["labels"]["should_speak"], **r})
    return rows


AXES = {
    "check": [*G.BASE_COST, "unregistered_check"],
    "status": ["degraded", "down"],
    "later_turns": LATER,
    "silence_s": [0.1, 0.5, 0.8, 1.2, 3.0],
    "self_repaired_p": [0.2, 0.45],
    "interrupt_p": [0.3, 0.5, 0.9],
    "later_claim_supports_check": [False, True],
    "seconds_since_last_spoke": [None, 5.0, 30.0],  # None = never spoke (inf)
}
REASONS = ["persisted", "not_repaired", "min_silence", "floor_open", "worth_it", "cooldown"]


def grid() -> list[list]:
    """One compact row per point of AXES (itertools.product order):
    [speak, blocked_by, repaired_by, cost_level, floor_p, failed-reasons bitmask]."""
    rows = []
    for values in itertools.product(*AXES.values()):
        kw = dict(zip(AXES, values))
        if kw["seconds_since_last_spoke"] is None:
            kw["seconds_since_last_spoke"] = float("inf")
        d = G.decide(G.GateInput(**kw))
        mask = sum(1 << i for i, k in enumerate(REASONS) if not d.reasons[k])
        rows.append([d.speak, d.blocked_by, d.repaired_by, d.cost_level, d.floor_p, mask])
    return rows


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    data = {"source": "spike/egghead_gate.py", "levels": G.LEVELS, "reasons": REASONS,
            "pass2": pass2(), "axes": AXES, "grid": grid()}
    OUT.write_text(json.dumps(data, separators=(",", ":")) + "\n")
    print(f"wrote {OUT}: {len(data['pass2'])} pass-2 rows, {len(data['grid'])} grid rows")


if __name__ == "__main__":
    main()
