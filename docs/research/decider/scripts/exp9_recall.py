"""Exp 9: claim/route recall. Extra narrow yes/no layers, combos, and route-gate thresholds.
Tune on dev only (with leave-one-out CV for the learned combo); then `python exp9_recall.py heldout` runs the frozen choice once."""
import json, sys, math
from lib import ask_many, load, prf, auc, ROOT, best_threshold, binary_metrics_at
from common import render, CLAIM_Q, RES, CHECKS, W, alias_hits, gold_route
split = sys.argv[1]; items = load(split)
Q = {"short": CLAIM_Q["short"], "repo": CLAIM_Q["repo"],
     "fact": "Is the latest speaker saying how something is right now, as a fact rather than a guess, plan or question?",
     "names": "Does the latest utterance mention a specific system, service, database, API, queue or metric?",
     "status": "Does the latest utterance report a status, number or observation, such as fine, down, slow, errors, CPU, or a deploy?",
     "hedge": "Is the latest speaker unsure, guessing, asking, or saying what they will do, rather than stating what is true now?"}
def lg(p): p = min(max(p, 1e-4), 1 - 1e-4); return math.log(p / (1 - p))
# windows: w1 for all (exp1 finding); one batch per line (batching is free, exp8)
r = ask_many([(render(it, "kv", 1), {k: {"type": "noul", "instructions": v} for k, v in Q.items()}, "exp9:layers") for it in items])
X = [[lg(x["answers"][k]["noul"]) for k in Q] for x in r]; y = [it["labels"]["is_claim"] for it in items]
def fit(X, y, l2=1.0, it=800, lr=0.1):
    w = [0.0] * (len(X[0]) + 1)
    for _ in range(it):
        g = [0.0] * len(w)
        for xi, yi in zip(X, y):
            z = w[-1] + sum(a * b for a, b in zip(w, xi)); p = 1 / (1 + math.exp(-z)); e = p - yi
            for j, a in enumerate(xi): g[j] += e * a
            g[-1] += e
        w = [wj - lr * (gj / len(X) + (l2 * wj / len(X) if j < len(xi) else 0)) for j, (wj, gj) in enumerate(zip(w, g))]
    return w
pred = lambda w, xi: 1 / (1 + math.exp(-(w[-1] + sum(a * b for a, b in zip(w, xi)))))
out = {"n": len(items)}
for j, k in enumerate(Q): out[f"single:{k}"] = {"AUC": round(auc([(X[i][j], y[i]) for i in range(len(y))]), 3)}
sig = lambda z: 1 / (1 + math.exp(-z))
combos = {"short": [0], "short+fact+status-hedge": [0, 2, 4, 5], "all6": [0, 1, 2, 3, 4, 5], "short+status": [0, 4]}
P_ = {}
if split == "dev":
    for name, cols in combos.items():
        Xs = [[x[c] for c in cols] for x in X]
        loo = [pred(fit(Xs[:i] + Xs[i + 1:], y[:i] + y[i + 1:]), Xs[i]) for i in range(len(y))]
        pr = list(zip(loo, y)); t = best_threshold(pr)
        out[f"combo:{name}"] = {"AUC_loo": round(auc(pr), 3), "at0.5": binary_metrics_at(pr, 0.5), "best_t": binary_metrics_at(pr, t)}
        P_[name] = fit(Xs, y)
    json.dump({k: v for k, v in P_.items()}, open(f"{ROOT}/results/exp9_weights_dev.json", "w"))
FROZEN = json.load(open(f"{ROOT}/results/exp9_weights_dev.json"))
# ---------- routing with a chosen claim combo and route-gate settings ----------
def rot(d, k): ks = list(d); ks = ks[k:] + ks[:k]; return {x: d[x] for x in ks}
RESI = "Which single named resource is the latest utterance about? Use earlier turns to resolve words like 'it' or 'the database'."
def route_all(pc, tc):
    plan = [{"id": it["id"], "pc": p} for it, p in zip(items, pc)]
    jobs, need = [], []
    for it, p in zip(items, plan):
        if p["pc"] < tc: continue
        hits = alias_hits(it["latest"]["text"])
        if len(hits) == 1: p["res"], p["rc"] = hits[0], 1.0; continue
        short = hits if hits else ([q for t in it["context"][-2:] for q in alias_hits(t["text"])] or list(RES))
        opts = {**{q: RES[q] for q in dict.fromkeys(short)}, "unknown": "unknown: unclear which single resource, or several, or none"}
        for k in range(len(opts)):
            jobs.append((render(it, "kv", 3), {"r": {"type": "choice", "instructions": RESI, "criteria": rot(opts, k)}}, "final:res")); need.append((p["id"], len(opts)))
    agg = {}
    for (iid, n), x in zip(need, ask_many(jobs)):
        for lab, v in x["answers"]["r"]["probabilities"].items(): agg.setdefault(iid, {}).setdefault(lab, 0); agg[iid][lab] += v / n
    for p in plan:
        if p["id"] in agg:
            a = agg[p["id"]]; top = max(a, key=a.get); n = len(a); p["res"], p["rc"] = top, (n * a[top] - 1) / (n - 1)
    byid = {it["id"]: it for it in items}; jobs, need = [], []
    for p in plan:
        if p.get("res") in W["checks"]:
            it = byid[p["id"]]; opts = {c: CHECKS[c] for c in W["checks"][p["res"]]}; opts["none"] = "None of these checks can verify it"
            for k in range(len(opts)):
                jobs.append((render(it, "kv", 3), {"c": {"type": "choice", "instructions": f"Which check would verify what the latest utterance says about {p['res']}?", "criteria": rot(opts, k)}}, "final:check")); need.append((p["id"], len(opts)))
    agg = {}
    for (iid, n), x in zip(need, ask_many(jobs)):
        for lab, v in x["answers"]["c"]["probabilities"].items(): agg.setdefault(iid, {}).setdefault(lab, 0); agg[iid][lab] += v / n
    for p in plan:
        if p["id"] in agg:
            a = agg[p["id"]]; top = max(a, key=a.get); n = len(a); p["chk"] = top; p["cc"] = (n * a[top] - 1) / (n - 1)
    return plan
def score(plan, tr, tcc, mode):
    def rt(p):
        if "chk" not in p or p["chk"] == "none" or p["res"] == "unknown": return None
        s = min(p["pc"], p["rc"], p["cc"]) if mode == "min" else min(p["rc"], p["cc"])
        return (p["chk"], p["res"]) if p["cc"] >= tcc and s >= tr else None
    tp = fp = fn = 0
    for it, p in zip(items, plan):
        g = gold_route(it); q = rt(p)
        tp += bool(q and q == g); fp += bool(q and q != g); fn += bool(g and q != g)
    a, b, c = prf(tp, fp, fn); return {"P": round(a, 3), "R": round(b, 3), "F1": round(c, 3), "fired": tp + fp}
from final_platt import platt
pc_base = [platt("claim", x["answers"]["short"]["noul"]) for x in r]
grid = []
for cname in ["short", "short+fact+status-hedge"]:
    pc = pc_base if cname == "short" else [pred(FROZEN[cname], [X[i][c] for c in combos[cname]]) for i in range(len(items))]
    for tc in (0.3, 0.4, 0.5):
        plan = route_all(pc, tc)
        out[f"claimF1:{cname}:tc{tc}"] = binary_metrics_at(list(zip(pc, y)), tc)
        for tr in (0.0, 0.25, 0.5):
            for tcc in (0.0, 0.125, 0.25):
                for mode in ("min", "nopc"):
                    grid.append({"claim": cname, "tc": tc, "tr": tr, "tcc": tcc, "mode": mode, **score(plan, tr, tcc, mode)})
out["route_grid"] = grid
json.dump(out, open(f"{ROOT}/results/exp9_{split}.json", "w"), indent=1)
for k, v in out.items():
    if k != "route_grid": print(k, v)
for g in sorted(grid, key=lambda g: -g["F1"])[:12]: print(g)
base = [g for g in grid if g["claim"] == "short" and g["tc"] == 0.5 and g["tr"] == 0.5 and g["tcc"] == 0.125 and g["mode"] == "min"]; print("frozen-like:", base)
