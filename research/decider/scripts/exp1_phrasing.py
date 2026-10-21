"""Exp 1: question wording x state format x context window, for is_claim / addressed / finished."""
import json, sys, itertools
from lib import ask_many, load, full_binary, STATS
from common import render, CLAIM_Q, ADDR_Q, FIN_Q
split = sys.argv[1] if len(sys.argv) > 1 else "dev"
items = load(split)
def qs():
    q = {}
    for k, v in CLAIM_Q.items(): q[f"claim_{k}"] = {"type": "noul", "instructions": v}
    for k, v in ADDR_Q.items(): q[f"addr_{k}"] = {"type": "noul", "instructions": v}
    for k in ("repo", "examples"): q[f"fin_{k}"] = {"type": "noul", "instructions": FIN_Q[k]}
    return q
configs = list(itertools.product(["raw", "tagged", "kv"], [1, 3, 6]))
jobs = [(render(it, f, w), qs(), f"exp1:{f}:{w}") for f, w in configs for it in items]
resp = ask_many(jobs)
out = {}; i = 0
gold = {"claim": lambda it: it["labels"]["is_claim"], "addr": lambda it: it["labels"]["addressed_agent"],
        "fin": lambda it: it["labels"]["turn_finished"]}
lat = []
for f, w in configs:
    rs = resp[i:i + len(items)]; i += len(items)
    lat += [r["latency_ms"] for r in rs]
    for qid in qs():
        task = qid.split("_")[0]
        pairs = [(r["answers"][qid]["noul"], bool(gold[task](it))) for r, it in zip(rs, items)]
        out[f"{qid}|{f}|w{w}"] = full_binary(pairs)
json.dump({"split": split, "metrics": out, "median_latency_ms": sorted(lat)[len(lat)//2], "stats": STATS},
          open(f"../results/exp1_{split}.json", "w"), indent=1)
for task in ("claim", "addr", "fin"):
    rows = sorted([(v["AUC"], k, v) for k, v in out.items() if k.startswith(task)], reverse=True)
    print(f"== {task} top 6 / bottom 2")
    for F, k, v in rows[:6] + rows[-2:]:
        print(f"  {k:28s} F1 {v['F1']:.2f} P {v['P']:.2f} R {v['R']:.2f} acc {v['acc']:.2f} ECE {v["ECE"]:.3f} AUC {v["AUC"]:.2f} bestF1 {v["F1_at_best_t"]:.2f}@{v["best_t"]}")
print(STATS)
