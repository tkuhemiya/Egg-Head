"""Exp 11: LLM baseline prompting on dev. Reasoning budget (effort none/low/default), rubric prompt, reasoning-before-answer
key order, self-consistency (k=3, temperature 0.7, majority vote). `heldout CONFIG` runs one frozen config once."""
import json, sys, statistics as S
from concurrent.futures import ThreadPoolExecutor
import llm_baseline as L
from lib import load, prf, ROOT
from common import gold_route
V1 = L.SYS
RUBRIC = V1.replace("Answer with JSON only:", """Rubric, apply in order:
1. Hedged ("maybe", "I think", "could be"), a question, a plan ("I'll", "let's"), or about earlier/yesterday -> is_claim false.
2. Otherwise, if it reports how a named or clearly referenced system/metric/deploy is now (fine, down, slow, CPU, errors, deployed or not) -> is_claim true.
3. addressed is true only if the speaker is talking to Egg Head / the assistant / the bot, not to a person.
4. resource: resolve pronouns from earlier turns; if two resources or none are clear use "unknown".
5. check: pick the check whose description matches the asserted property; null if no listed check for that resource fits.
Answer with JSON only:""")
WHY = V1.replace('Answer with JSON only: {{', 'X').replace('Answer with JSON only: {"is_claim"', 'Answer with JSON only, writing a one-sentence "why" FIRST: {"why": str, "is_claim"')
CFG = {"v1_default": (V1, {}), "v1_none": (V1, {"reasoning": {"effort": "none"}}), "v1_low": (V1, {"reasoning": {"effort": "low"}}),
       "rubric_default": (RUBRIC, {}), "rubric_none": (RUBRIC, {"reasoning": {"effort": "none"}}), "why_none": (WHY, {"reasoning": {"effort": "none"}})}
def run(items, cfg, k=1):
    L.SYS, L.EXTRA = CFG[cfg][0], dict(CFG[cfg][1])
    if k > 1: L.EXTRA["temperature"] = 0.7
    jobs = [(it, s if k > 1 else None) for it in items for s in range(k)]
    with ThreadPoolExecutor(2) as ex: outs = list(ex.map(lambda j: L.call(*j), jobs))
    return [outs[i * k:(i + 1) * k] for i in range(len(items))]
def vote(ps, key):
    v = [p.get(key) for p in ps]; return max(set(map(json.dumps, v)), key=lambda x: [json.dumps(a) for a in v].count(x))
def score(items, groups):
    P = [{key: json.loads(vote([L.parse(o["text"]) for o in g], key)) for key in ("is_claim", "addressed", "resource", "check")} for g in groups]
    def b(pred, gold):
        tp = sum(pred(i) and gold(it) for i, it in enumerate(items)); fp = sum(pred(i) and not gold(it) for i, it in enumerate(items)); fn = sum(gold(it) and not pred(i) for i, it in enumerate(items))
        return [round(x, 3) for x in prf(tp, fp, fn)]
    rt = lambda i: (P[i]["check"], P[i]["resource"]) if P[i]["is_claim"] and P[i]["check"] and P[i]["resource"] not in (None, "unknown") else None
    tp = sum(bool(rt(i)) and rt(i) == gold_route(it) for i, it in enumerate(items)); fp = sum(bool(rt(i)) and rt(i) != gold_route(it) for i, it in enumerate(items))
    fn = sum(bool(gold_route(it)) and rt(i) != gold_route(it) for i, it in enumerate(items))
    fl = [o for g in groups for o in g]; lat = sorted(o["ms"] for o in fl if o["ms"]); u = [o["usage"] for o in fl if o["usage"]]
    per_line_lat = sorted(max(o["ms"] or 0 for o in g) for g in groups)
    return {"claim_PRF": b(lambda i: bool(P[i]["is_claim"]), lambda it: it["labels"]["is_claim"]),
            "addr_PRF": b(lambda i: bool(P[i]["addressed"]), lambda it: it["labels"]["addressed_agent"]),
            "route_PRF": [round(x, 3) for x in prf(tp, fp, fn)], "parse_fail": sum(not L.parse(o["text"]) for o in fl),
            "p50_ms": round(per_line_lat[len(per_line_lat) // 2]), "p95_ms": round(per_line_lat[int(.95 * (len(per_line_lat) - 1))]),
            "out_tok": round(S.mean(x["completion_tokens"] for x in u)), "usd": round(sum(x["prompt_tokens"] * .3e-6 + x["completion_tokens"] * 2.4e-6 for x in u), 3)}
if __name__ == "__main__":
    split = sys.argv[1]; items = [it for it in load(split) if it["kind"] != "repo_gate"]
    cfgs = sys.argv[2:] or list(CFG); res = {}
    for c in cfgs:
        k = 3 if c.endswith("@sc3") else 1; base = c.replace("@sc3", "")
        res[c] = score(items, run(items, base, k)); print(c, res[c], flush=True)
    p = f"{ROOT}/results/exp11_{split}.json"; old = json.load(open(p)) if __import__("os").path.exists(p) else {}
    old.update(res); json.dump(old, open(p, "w"), indent=1)
