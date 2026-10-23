"""Exp 4: claim routing. One big choice vs the repo's one batch vs decomposed sub-questions, with and without a code pre-pass."""
import json, sys
from lib import ask_many, load, STATS, prf
from common import render, CHECKS, RES, W, CLAIM_Q, alias_hits, gold_route
split = sys.argv[1] if len(sys.argv) > 1 else "dev"
items = load(split)
CLAIM = {"type": "noul", "instructions": CLAIM_Q["short"]}
PAIRS = {f"{c}@{r}": f"{CHECKS[c].split(':')[0]} of {r}" for r, cs in W["checks"].items() for c in cs}
PAIRS["none"] = "None: the latest utterance is not a checkable statement about one of these systems"
RQ = {**RES, "unknown": "unknown: unclear which single resource, or several, or none"}
CK = {**CHECKS, "none": "None of these checks can verify it"}
def ckq(res):
    d = {c: CHECKS[c] for c in W["checks"][res]}; d["none"] = "None of these checks can verify it"
    return {"type": "choice", "instructions": f"Which check would verify what the latest utterance says about {res}?", "criteria": d}
RESI = "Which single named resource is the latest utterance about? Use earlier turns to resolve words like 'it' or 'the database'."
s1, s3 = (lambda it: render(it, "kv", 1)), (lambda it: render(it, "kv", 3))
jobs = []
for it in items:
    jobs.append((s3(it), {"claim": CLAIM, "pair": {"type": "choice", "instructions": "Which check on which system would verify the latest utterance?", "criteria": PAIRS}}, "exp4:R1"))
    jobs.append((s3(it), {"claim": CLAIM, "check": {"type": "choice", "instructions": "Which one check would verify the latest utterance? If it is not a checkable claim, choose none.", "criteria": CK},
                          "res": {"type": "choice", "instructions": RESI, "criteria": RQ}}, "exp4:R2"))
    hits = alias_hits(it["latest"]["text"])
    short = hits if len(hits) > 1 else ([r for t in it["context"][-2:] for r in alias_hits(t["text"])] or list(RES))
    jobs.append((s3(it), {"res_short": {"type": "choice", "instructions": RESI, "criteria": {**{r: RES[r] for r in dict.fromkeys(short)}, "unknown": RQ["unknown"]}}}, "exp4:R4res"))
r1 = ask_many(jobs)
# stage-2 check questions for each resource candidate the stage-1 answers produced
out = {}; jobs2 = []; need = []
for n, it in enumerate(items):
    a1, a2, a4 = r1[3 * n]["answers"], r1[3 * n + 1]["answers"], r1[3 * n + 2]["answers"]
    hits = alias_hits(it["latest"]["text"])
    res3 = a2["res"]["choice"]
    res4 = hits[0] if len(hits) == 1 else a4["res_short"]["choice"]
    conf4 = 1.0 if len(hits) == 1 else a4["res_short"]["confidence"]
    out[it["id"]] = {"R1": a1, "R2": a2, "R4res": a4, "res3": res3, "res4": res4, "conf4": conf4}
    for tag, res in (("R3", res3), ("R4", res4)):
        if res in W["checks"]:
            jobs2.append((s3(it), {"ck": ckq(res)}, "exp4:" + tag)); need.append((it["id"], tag))
r2 = ask_many(jobs2)
for (iid, tag), r in zip(need, r2): out[iid][tag + "ck"] = r["answers"]["ck"]
def preds(it, o, variant):
    p = o["R1"]["claim"]["noul"] if variant != "R1only" else 1.0
    if variant in ("R1", "R1only"):
        ch = o["R1"]["pair"]["choice"]
        if ch == "none": return None, 0
        c, r = ch.split("@"); return (c, r), min(p, o["R1"]["pair"]["confidence"])
    if variant == "R2":
        c, r = o["R2"]["check"]["choice"], o["R2"]["res"]["choice"]
        if c == "none" or r == "unknown": return None, 0
        return (c, r), min(o["R2"]["claim"]["noul"], o["R2"]["check"]["confidence"], o["R2"]["res"]["confidence"])
    tag = variant
    r = o["res3"] if tag == "R3" else o["res4"]; rc = o["R2"]["res"]["confidence"] if tag == "R3" else o["conf4"]
    if r not in W["checks"] or (tag + "ck") not in o: return None, 0
    ck = o[tag + "ck"]
    if ck["choice"] == "none": return None, 0
    return (ck["choice"], r), min(p, rc, ck["confidence"])
res = {}
for v in ("R1", "R2", "R3", "R4"):
    rows = []
    for it in items:
        pr, sc = preds(it, out[it["id"]], v); rows.append((pr, sc, gold_route(it)))
    curve = []
    for t in [i / 20 for i in range(0, 20)]:
        tp = sum(1 for pr, sc, g in rows if pr and sc >= t and pr == g); fp = sum(1 for pr, sc, g in rows if pr and sc >= t and pr != g)
        fn = sum(1 for pr, sc, g in rows if g and not (pr and sc >= t and pr == g))
        P, R, F = prf(tp, fp, fn); curve.append({"t": t, "P": P, "R": R, "F1": F, "fired": tp + fp})
    best = max(curve, key=lambda c: c["F1"])
    res[v] = {"best": best, "at0.5": [c for c in curve if c["t"] == 0.5][0], "curve": curve,
              "requests_per_utt": {"R1": 1, "R2": 1, "R3": 1 + len([1 for it in items if 'R3ck' in out[it['id']]]) / len(items),
                                   "R4": 1 + len([1 for it in items if 'R4ck' in out[it['id']]]) / len(items)}[v]}
    print(v, "best", {k: round(x, 2) if isinstance(x, float) else x for k, x in best.items()}, "@0.5", {k: round(x, 2) if isinstance(x, float) else x for k, x in res[v]["at0.5"].items()})
print("gold positives", sum(1 for it in items if gold_route(it)))
print("code pre-pass settled resource alone on", sum(1 for it in items if len(alias_hits(it['latest']['text'])) == 1), "of", len(items))
json.dump({"split": split, "summary": res, "raw": out}, open(f"../results/exp4_{split}.json", "w"))
print(STATS)
