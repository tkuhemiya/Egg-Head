"""Exp 3: first branch 'ask-the-agent vs claim vs other'. One 3-way choice (canonical / all rotations averaged)
vs two yes/no questions in one batch vs a 3-level score for claim-ness vs staged tree (addr first, then claim)."""
import json, sys, statistics as S
from lib import ask_many, load, STATS, ece, auc, prf
from common import render, CLAIM_Q, ADDR_Q
split = sys.argv[1] if len(sys.argv) > 1 else "dev"
items = load(split)
def gold(it):
    l = it["labels"]; return "request" if l["addressed_agent"] else "claim" if l["is_claim"] else "other"
OPTS = {"request": "A request or question addressed to the AI assistant Egg Head",
        "claim": "A statement of fact about the current state of a system, service, metric or recent deploy",
        "other": "Anything else: questions to people, guesses, plans, past events, chit-chat"}
def rot(d, k): ks = list(d); ks = ks[k:] + ks[:k]; return {x: d[x] for x in ks}
BR = "What kind of utterance is the LATEST one?"
SC = {"type": "score", "instructions": "How clearly does the latest speaker state a fact about the current state of a computer system or service?",
      "criteria": ["not a statement about a system", "unclear or hedged", "clearly states the system's current state"]}
jobs = []
for it in items:
    s = render(it, "kv", 1)
    for k in range(3): jobs.append((s, {"t": {"type": "choice", "instructions": BR, "criteria": rot(OPTS, k)}}, f"exp3:choice{k}"))
    jobs.append((s, {"claim": {"type": "noul", "instructions": CLAIM_Q["short"]}, "addr": {"type": "noul", "instructions": ADDR_Q["repo"]}}, "exp3:noul2"))
    jobs.append((s, {"sc": SC}, "exp3:score"))
    jobs.append((s, {"addr": {"type": "noul", "instructions": ADDR_Q["repo"]}}, "exp3:tree_addr"))
    jobs.append((s, {"claim": {"type": "noul", "instructions": CLAIM_Q["short"]}}, "exp3:tree_claim"))
R = ask_many(jobs); W = 7
def mf1(preds):
    out = {}
    for c in OPTS:
        tp = sum(p == c and g == c for p, g in preds); fp = sum(p == c and g != c for p, g in preds); fn = sum(p != c and g == c for p, g in preds)
        out[c] = prf(tp, fp, fn)[2]
    return {"acc": round(S.mean(p == g for p, g in preds), 3), "macroF1": round(S.mean(out.values()), 3), **{f"F1_{c}": round(v, 3) for c, v in out.items()}}
def best_pair_t(gets):
    best = None
    for ta in [i / 20 for i in range(2, 19)]:
        for tc in [i / 20 for i in range(2, 19)]:
            pr = [("request" if a >= ta else "claim" if c >= tc else "other", gold(it)) for (a, c), it in zip(gets, items)]
            m = mf1(pr)
            if not best or m["macroF1"] > best[0]["macroF1"]: best = (m, ta, tc)
    return best
res = {}; rows = {k: [] for k in ("canon", "rot", "noul", "tree", "score")}; lat = {k: [] for k in rows}
for n, it in enumerate(items):
    r = R[W * n:W * n + W]; g = gold(it)
    a0 = r[0]["answers"]["t"]; rows["canon"].append((a0["choice"], g, max(a0["probabilities"].values()))); lat["canon"].append(r[0]["latency_ms"])
    avg = {c: S.mean(x["answers"]["t"]["probabilities"][c] for x in r[:3]) for c in OPTS}; top = max(avg, key=avg.get)
    rows["rot"].append((top, g, avg[top])); lat["rot"].append(sum(x["latency_ms"] for x in r[:3]))
    a, c = r[3]["answers"]["addr"]["noul"], r[3]["answers"]["claim"]["noul"]; rows["noul"].append((a, c)); lat["noul"].append(r[3]["latency_ms"])
    rows["score"].append(r[4]["answers"]["sc"]); lat["score"].append(r[4]["latency_ms"])
    ta = r[5]["answers"]["addr"]["noul"]; tc = r[6]["answers"]["claim"]["noul"]; rows["tree"].append((ta, tc))
    lat["tree"].append(r[5]["latency_ms"] + (r[6]["latency_ms"] if ta < 0.5 else 0))
gl = [gold(it) for it in items]
for k in ("canon", "rot"):
    m = mf1([(p, g) for p, g, _ in rows[k]]); m["ECE"] = round(ece([(cf, p == g) for p, g, cf in rows[k]]), 3)
    m["calls_per_utt"] = 1 if k == "canon" else 3; m["latency_p50_ms"] = S.median(lat[k]); res["choice3_" + k] = m
for k in ("noul", "tree"):
    m = mf1([("request" if a >= .5 else "claim" if c >= .5 else "other", g) for (a, c), g in zip(rows[k], gl)])
    b = best_pair_t(rows[k]); m["best_dev_thresholds"] = {"t_addr": b[1], "t_claim": b[2], **b[0]}
    m["calls_per_utt"] = 1 if k == "noul" else round(sum(1 + (a < .5) for a, _ in rows[k]) / len(items), 2)
    m["latency_p50_ms"] = S.median(lat[k]); res[("yesno2_one_batch" if k == "noul" else "staged_tree_addr_then_claim")] = m
cl = [(it["labels"]["is_claim"]) for it in items]
sc = [x["score"] for x in rows["score"]]; ss = [x["probabilities"]["2"] for x in rows["score"]]
nc = [c for _, c in rows["noul"]]
res["claim_signal_AUC"] = {"noul_yes_prob": round(auc(list(zip(nc, cl))), 3), "score_expected_value": round(auc(list(zip(sc, cl))), 3),
                           "score_top_level_prob": round(auc(list(zip(ss, cl))), 3)}
res["gold_counts"] = {c: gl.count(c) for c in OPTS}
print(json.dumps(res, indent=1)); print(STATS)
json.dump({"split": split, "summary": res}, open(f"../results/exp3_{split}.json", "w"), indent=1)
