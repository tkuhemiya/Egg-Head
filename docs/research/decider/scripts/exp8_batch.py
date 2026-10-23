"""Exp 8: does asking many questions in one request change the answers? Latency vs question count."""
import json, sys, statistics as S
from lib import ask_many, load, STATS
from common import render, CLAIM_Q, ADDR_Q, FIN_Q, INT_Q
split = sys.argv[1] if len(sys.argv) > 1 else "dev"
items = load(split)[:60]
Q = {"claim": {"type": "noul", "instructions": CLAIM_Q["short"]}, "addr": {"type": "noul", "instructions": ADDR_Q["repo"]},
     "fin": {"type": "noul", "instructions": FIN_Q["repo"]}, "int": {"type": "noul", "instructions": INT_Q["repo"]},
     "question": {"type": "noul", "instructions": "Is the latest utterance a question?"},
     "plan": {"type": "noul", "instructions": "Does the latest speaker say what they will do next?"},
     "chit": {"type": "noul", "instructions": "Is the latest utterance small talk or logistics?"},
     "urg": {"type": "score", "instructions": "How urgent is the latest utterance for the incident?", "criteria": ["not urgent", "somewhat urgent", "very urgent"]}}
jobs = []
for it in items:
    st = render(it, "tagged", 3)
    jobs.append((st, Q, "exp8:batch8"))
    jobs.append((st, dict(reversed(list(Q.items()))), "exp8:batch8_reversed"))
    for k in Q: jobs.append((st, {k: Q[k]}, "exp8:single"))
    jobs.append((st, {k: Q[k] for k in list(Q)[:2]}, "exp8:batch2"))
    jobs.append((st, {k: Q[k] for k in list(Q)[:4]}, "exp8:batch4"))
resp = ask_many(jobs)
per = len(Q) + 4
def val(a): return a["noul"] if a["type"] == "noul" else a.get("score", a.get("expected", 0))
d8, d8r, flips, lat = [], [], 0, {1: [], 2: [], 4: [], 8: []}
for n in range(len(items)):
    b, br = resp[n * per]["answers"], resp[n * per + 1]["answers"]
    singles = {k: resp[n * per + 2 + j]["answers"][k] for j, k in enumerate(Q)}
    for k in Q:
        if Q[k]["type"] != "noul": continue
        d8.append(abs(b[k]["noul"] - singles[k]["noul"])); d8r.append(abs(b[k]["noul"] - br[k]["noul"]))
        flips += (b[k]["noul"] >= 0.5) != (singles[k]["noul"] >= 0.5)
    lat[8].append(resp[n * per]["latency_ms"]); lat[1] += [resp[n * per + 2 + j]["latency_ms"] for j in range(len(Q))]
    lat[2].append(resp[n * per + 2 + len(Q)]["latency_ms"]); lat[4].append(resp[n * per + 3 + len(Q)]["latency_ms"])
out = {"mean_abs_diff_batch_vs_single": S.mean(d8), "max_abs_diff": max(d8), "decision_flips": flips, "n_answers": len(d8),
       "mean_abs_diff_batch_order": S.mean(d8r), "latency_p50_ms": {k: S.median(v) for k, v in lat.items()},
       "latency_p95_ms": {k: sorted(v)[int(0.95 * len(v))] for k, v in lat.items()}}
print(json.dumps(out, indent=1))
json.dump(out, open(f"../results/exp8_{split}.json", "w"), indent=1)
print(STATS)
