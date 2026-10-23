"""Exp 2+3: option-order bias and its mitigations; N-way choice vs noul-per-option vs staged noul tree.

Decisions: utterance type (9 options, Themiya's first branch), check (7 options, claims only),
asserted state (5 options, claims only). Every cyclic rotation of the option list is asked.
"""
import json, sys
from lib import ask_many, load, STATS, choice_conf, ece
from common import render, UTYPES, CHECKS
split = sys.argv[1] if len(sys.argv) > 1 else "dev"
items = load(split)
ASSERT = {"healthy": "it is fine, normal, working or not the problem", "degraded": "it is slow, erroring, backed up or struggling",
          "down": "it is completely down or unreachable", "changed": "something was deployed, released or changed",
          "unchanged": "nothing was deployed, released or changed"}
def rot(d, k):
    ks = list(d); ks = ks[k:] + ks[:k]; return {x: d[x] for x in ks}
def bare(d): return {k: k.replace("_", " ") for k in d}
def st(it): return render(it, "kv", 3)
TYPE_I = "What kind of utterance is the latest utterance?"
jobs, keys = [], []
for it in items:
    for style, opts in (("def", UTYPES), ("bare", bare(UTYPES))):
        for k in range(len(UTYPES)):
            jobs.append((st(it), {"t": {"type": "choice", "instructions": TYPE_I, "criteria": rot(opts, k)}}, "exp2:type"))
            keys.append((it["id"], "type", style, k))
    # noul per option (two requests, <=8 questions each)
    names = list(UTYPES)
    for part in (names[:5], names[5:]):
        jobs.append((st(it), {f"n_{n}": {"type": "noul", "instructions": f"Is the latest utterance this kind: {UTYPES[n]}?"} for n in part}, "exp3:noul_per_option"))
        keys.append((it["id"], "noul", "def", tuple(part)))
claims = [it for it in items if it["labels"]["is_claim"] and it["labels"]["check"]]
for it in claims:
    ck = dict(CHECKS); ck["none"] = "None of these checks can verify it"
    for k in range(len(ck)):
        jobs.append((st(it), {"c": {"type": "choice", "instructions": "Which one check would verify the latest utterance?", "criteria": rot(ck, k)}}, "exp2:check"))
        keys.append((it["id"], "check", "def", k))
    for k in range(len(ASSERT)):
        jobs.append((st(it), {"a": {"type": "choice", "instructions": "What does the latest speaker claim about the system they mention?", "criteria": rot(ASSERT, k)}}, "exp2:asserted"))
        keys.append((it["id"], "asserted", "def", k))
print(len(jobs), "jobs", flush=True)
resp = ask_many(jobs)
json.dump({"split": split, "rows": [[k, r["answers"], r["latency_ms"]] for k, r in zip(keys, resp)]},
          open(f"../results/exp2_{split}.json", "w"))
print(STATS)
