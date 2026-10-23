"""Export the research pipeline's renderers, wording and combiners as a fixture for the
TypeScript runtime (test/fixtures/research-parity.json). No Decider calls.

    cd research/decider/scripts && python3 export_runtime_parity.py
"""
import json, math, os, random
from lib import ROOT, load
from common import render, CLAIM_Q, FIN_Q, RES, W, alias_hits

# Copied verbatim from exp9_recall.py and final_eval.py (both call the API on import).
Q = {"short": CLAIM_Q["short"], "repo": CLAIM_Q["repo"],
     "fact": "Is the latest speaker saying how something is right now, as a fact rather than a guess, plan or question?",
     "names": "Does the latest utterance mention a specific system, service, database, API, queue or metric?",
     "status": "Does the latest utterance report a status, number or observation, such as fine, down, slow, errors, CPU, or a deploy?",
     "hedge": "Is the latest speaker unsure, guessing, asking, or saying what they will do, rather than stating what is true now?"}
RESI = "Which single named resource is the latest utterance about? Use earlier turns to resolve words like 'it' or 'the database'."
RQU = "unknown: unclear which single resource, or several, or none"
REP = "After the flagged claim, did someone on the call already say it was wrong, or question whether it was right? Agreeing with it is not a correction."
NONE_CHECK = "None of these checks can verify it"
def check_instructions(res): return f"Which check would verify what the latest utterance says about {res}?"

OUT = os.path.join(ROOT, "..", "..", "test", "fixtures", "research-parity.json")
WEIGHTS = json.load(open(os.path.join(ROOT, "results", "exp9_weights_dev.json")))["short+fact+status-hedge"]
PLATT = json.load(open(os.path.join(ROOT, "results", "exp6_platt_dev.json")))

def lg(p): p = min(max(p, 1e-4), 1 - 1e-4); return math.log(p / (1 - p))
def combo(ps): return 1 / (1 + math.exp(-(WEIGHTS[-1] + sum(w * lg(p) for w, p in zip(WEIGHTS, ps)))))
def platt(name, p): a, b = PLATT[name]; return 1 / (1 + math.exp(-(a * lg(p) + b)))

def shortlist(it):
    hits = alias_hits(it["latest"]["text"])
    if len(hits) == 1: return hits
    short = hits if hits else ([r for t in it["context"][-2:] for r in alias_hits(t["text"])] or list(RES))
    return list(dict.fromkeys(short))

items = load()
rng = random.Random(7)
picked = [it for it in items if it["kind"] == "repo_gate"][:6] + rng.sample([it for it in items if it["kind"] != "repo_gate"], 30)
samples = []
for it in picked:
    s = {"id": it["id"], "turns": [[t["speaker"], t["text"]] for t in it["context"] + [it["latest"]]],
         "kv1": render(it, "kv", 1), "kv3": render(it, "kv", 3), "aliases": alias_hits(it["latest"]["text"]),
         "shortlist": shortlist(it)}
    if it["kind"] == "repo_gate":
        s["silence_s"] = it["pause_s"]
        s["ledger"] = [{"speaker": l["speaker"], "claim": l["claim"], "evidence": l["evidence"]} for l in it["ledger"]]
        s["gate_state"] = render(it, "tagged", 6, pause=True, ledger=True)
    samples.append(s)

grid = [[rng.random() for _ in range(4)] for _ in range(40)] + [[0.0, 1.0, 0.5, 1e-6], [1.0, 1.0, 1.0, 0.0]]
json.dump({
    "source": "research/decider/scripts/export_runtime_parity.py (exp9 frozen claim combo, final_eval routing and gate)",
    "wording": {"claim": Q, "resource": RESI, "unknown": RQU, "none_check": NONE_CHECK,
                "check_orders_db": check_instructions("orders-db"), "self_repaired": REP, "finished": FIN_Q["repo"]},
    "checks": {r: list(cs) for r, cs in W["checks"].items()},
    "combo": [{"p": ps, "out": combo(ps)} for ps in grid],
    "platt_fin": [{"p": p, "out": platt("fin", p)} for p in [0.0, 0.01, 0.2, 0.5, 0.8, 0.99, 1.0]],
    "samples": samples,
}, open(OUT, "w"), indent=1, ensure_ascii=False)
print("wrote", os.path.relpath(OUT), len(samples), "samples")
