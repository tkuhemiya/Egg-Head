"""Exp 6: calibration (reliability, ECE) per question, Platt recalibration fit on dev, abstain bands,
SlopGate-style confidence bands. Reads cached answers only (no new requests)."""
import json, math, sys
from lib import ask_many, load, ece_binary, binary_metrics_at, STATS
from common import render, CLAIM_Q, ADDR_Q, FIN_Q
split = sys.argv[1] if len(sys.argv) > 1 else "dev"
items = load(split)
QS = {"claim": ("kv", 1, CLAIM_Q["short"], lambda it: bool(it["labels"]["is_claim"])),
      "addr": ("kv", 1, ADDR_Q["repo"], lambda it: bool(it["labels"]["addressed_agent"])),
      "fin": ("tagged", 1, FIN_Q["repo"], lambda it: bool(it["labels"]["turn_finished"]))}
def single_q(fmt, w, text):
    return [(render(it, fmt, w), {"q": {"type": "noul", "instructions": text}}, "exp6") for it in items]
def logit(p): p = min(max(p, 1e-4), 1 - 1e-4); return math.log(p / (1 - p))
def fit_platt(pairs, iters=3000, lr=0.05):
    a, b = 1.0, 0.0
    for _ in range(iters):
        ga = gb = 0.0
        for p, g in pairs:
            z = a * logit(p) + b; q = 1 / (1 + math.exp(-z)); ga += (q - g) * logit(p); gb += (q - g)
        a -= lr * ga / len(pairs); b -= lr * gb / len(pairs)
    return a, b
def apply(a, b, p): return 1 / (1 + math.exp(-(a * logit(p) + b)))
def reliability(pairs, bins=5):
    rows = []
    for k in range(bins):
        lo, hi = k / bins, (k + 1) / bins
        s = [(p, g) for p, g in pairs if lo <= p < hi or (k == bins - 1 and p == 1)]
        if s: rows.append({"bin": f"{lo:.1f}-{hi:.1f}", "n": len(s), "mean_p": round(sum(p for p, _ in s) / len(s), 3), "frac_true": round(sum(g for _, g in s) / len(s), 3)})
    return rows
out = {}
params = json.load(open("../results/exp6_platt_dev.json")) if split != "dev" else {}
for name, (fmt, w, text, gold) in QS.items():
    rs = ask_many(single_q(fmt, w, text))
    pairs = [(r["answers"]["q"]["noul"], gold(it)) for r, it in zip(rs, items)]
    if split == "dev":
        a, b = fit_platt(pairs); params[name] = [a, b]
    a, b = params[name]
    cal = [(apply(a, b, p), g) for p, g in pairs]
    # abstain band: act only when |p - t| >= delta, else abstain
    bands = []
    for d in (0.0, 0.05, 0.1, 0.15, 0.2):
        kept = [(p, g) for p, g in cal if abs(p - 0.5) >= d]
        acc = sum((p >= 0.5) == g for p, g in kept) / len(kept) if kept else float("nan")
        bands.append({"delta": d, "coverage": round(len(kept) / len(cal), 3), "acc": round(acc, 3)})
    out[name] = {"ECE_raw": ece_binary(pairs), "ECE_platt": ece_binary(cal), "platt_ab": [a, b],
                 "reliability_raw": reliability(pairs), "reliability_platt": reliability(cal),
                 "F1_raw@0.5": binary_metrics_at(pairs, 0.5)["F1"], "F1_platt@0.5": binary_metrics_at(cal, 0.5)["F1"], "abstain": bands}
    print(name, json.dumps({k: v for k, v in out[name].items() if k not in ("reliability_platt",)}))
if split == "dev": json.dump(params, open("../results/exp6_platt_dev.json", "w"))
json.dump(out, open(f"../results/exp6_{split}.json", "w"), indent=1)
print(STATS)
