"""Re-score the speak gate on the pass-2 Decider answers (no model run needed).

Compares the pass-2 gate (questions.speak_gate) with the reworked code gate
(egghead_gate.py) on the 16 snippets that hold an open flagged claim, and writes
spike/REPORT-gate.md.

The reworked gate was written after reading these 16 snippets and the pass-2 errors, so
the score is a fit to them, not a held-out result. It needs a fresh labelled set and a
model run before it is quoted as accuracy.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import egghead_gate as G  # noqa: E402
import questions as Q  # noqa: E402


def claim_index(s: dict) -> int:
    speaker = s["ledger"][0]["speaker"]
    return next(i for i, t in enumerate(s["transcript"]) if t["speaker"] == speaker)


def gate_input(s: dict, a: dict) -> G.GateInput:
    item = s["ledger"][0]
    i = claim_index(s)
    turns = s["transcript"]
    status = Q.lookup(Q.load_world(), item["resource"], item["check"])["status"]
    supports = False
    if Q.route_gate(a) and len(turns) - 1 > i:
        same = (a["which_check"]["choice"] == item["check"]
                and a["which_resource"]["choice"] == item["resource"])
        supports = same and Q.compare(a["asserted_state"]["choice"], status) == "supports"
    return G.GateInput(
        check=item["check"], status=status,
        later_turns=[t["text"] for t in turns[i + 1:]],
        silence_s=s["silence_s"],
        self_repaired_p=a["self_repaired"]["noul"],
        interrupt_p=a["floor_free"]["noul"] if Q.FLOOR_INVERT else 1 - a["floor_free"]["noul"],
        later_claim_supports_check=supports,
    )


def prf(pairs):
    tp = sum(p and g for p, g in pairs)
    fp = sum(p and not g for p, g in pairs)
    fn = sum(g and not p for p, g in pairs)
    return tp, fp, fn, tp / (tp + fp) if tp + fp else None, tp / (tp + fn) if tp + fn else None


def pct(x):
    return "—" if x is None else f"{100 * x:.0f}%"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default=str(Q.DATASET))
    ap.add_argument("--results", default="out/results.jsonl")
    ap.add_argument("--report", default="REPORT-gate.md")
    ap.add_argument("--title", default="Speak gate rework: re-score on pass-2 answers")
    ap.add_argument("--note", default="The new gate was written after reading these 16 snippets and "
                    "the pass-2 errors. Read the score as a fit, not a held-out result.")
    args = ap.parse_args()
    snips = [json.loads(l) for l in (Q.HERE / args.dataset).read_text().splitlines() if l]
    results = {json.loads(l)["id"]: json.loads(l)
               for l in (Q.HERE / args.results).read_text().splitlines() if l}
    rows = []
    for s in snips:
        if not s["ledger"] or s["id"] not in results:
            continue
        a = results[s["id"]]["answers"]
        old = Q.speak_gate(a, s["silence_s"])
        d = G.decide(gate_input(s, a))
        rows.append((s, old, d))

    md = [f"# {args.title}", "", f"> {args.note}", ""]
    for name, key in (("Pass-2 gate (questions.speak_gate)", lambda r: r[1]),
                      ("Reworked gate (spike/egghead_gate.py)", lambda r: r[2].speak)):
        tp, fp, fn, p, r_ = prf([(key(r), r[0]["labels"]["should_speak"]) for r in rows])
        md.append(f"- {name}: precision **{pct(p)}**, recall **{pct(r_)}** "
                  f"(TP {tp}, FP {fp}, FN {fn}, n {len(rows)})")
    md += ["", "| id | gold | pass 2 | reworked | blocked by | repaired by | cost | P(gap) | silence s |",
           "|---|---|---|---|---|---|---|---|---|"]
    for s, old, d in rows:
        gold = s["labels"]["should_speak"]
        flag = "" if d.speak == gold else " ❌"
        md.append(f"| {s['id']}{flag} | {'speak' if gold else 'quiet'} | {'speak' if old else 'quiet'} "
                  f"| {'speak' if d.speak else 'quiet'} | {d.blocked_by or ''} | {d.repaired_by or ''} "
                  f"| {G.LEVELS[d.cost_level]} | {d.floor_p:.2f} | {s['silence_s']} |")
    (Q.HERE / args.report).write_text("\n".join(md) + "\n")
    print("\n".join(md))


if __name__ == "__main__":
    main()
