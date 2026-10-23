"""LLM-on-every-line baseline: Nemotron 3 Super 120B (free on OpenRouter; same model is nvidia.nemotron-super-3-120b on Bedrock).
One call per line, the model sees the last 6 turns, the resource catalogue, the check catalogue and (for gate items) the flagged claim + silence.
Raw outputs cached in results/llm_cache/. Key read from ~/.secrets/openrouter.env, never logged."""
import json, os, sys, time, hashlib, re, urllib.request, urllib.error, statistics as S
from concurrent.futures import ThreadPoolExecutor
from lib import load, prf, ROOT
from common import RES, CHECKS, W, gold_route, render
KEY = [l.split("=",1)[1].strip().strip('"') for l in open(os.path.expanduser("~/.secrets/openrouter.env")) if l.startswith("OPENROUTER_API_KEY")][0]
MODEL = os.environ.get("LLM", "nvidia/nemotron-3-super-120b-a12b")
EXTRA = {}
CACHE = os.path.join(ROOT, "results", "llm_cache"); os.makedirs(CACHE, exist_ok=True)
SYS = f"""You are the decision layer of Egg Head, an AI assistant listening to a live incident call. For the LATEST utterance only, decide:
- is_claim: does the latest speaker state, as fact, the CURRENT state of a system/service/metric or a recent deploy/change? Guesses, questions, plans, actions and statements about the past are not claims.
- addressed: is the latest utterance addressed to Egg Head (the AI assistant) rather than to the humans?
- resource: if is_claim, which single resource it is about (use earlier turns to resolve 'it', 'the database'), else null. One of: {json.dumps(RES)} or "unknown".
- check: if is_claim, which check would verify it, restricted to checks that exist for that resource, else null. Checks: {json.dumps(CHECKS)}. Checks available per resource: {json.dumps({r: list(c) for r, c in W['checks'].items()})}. Use null if none fits.
- speak: only when a FLAGGED CLAIM is given: should Egg Head speak up now to say the live check contradicts it? Stay quiet if someone already corrected or questioned it, or if the speaker is mid-sentence; speaking over people is costly. Otherwise null.
Answer with JSON only: {{"is_claim": bool, "addressed": bool, "resource": str|null, "check": str|null, "speak": bool|null}}"""
def prompt(it):
    gate = it["kind"] == "repo_gate"
    return render(it, "tagged", 6, pause=gate, ledger=gate)
def call(it, salt=None):
    msgs = [{"role": "system", "content": SYS}, {"role": "user", "content": prompt(it)}]
    body = {"model": MODEL, "messages": msgs, "temperature": 0, "max_tokens": 4000, **EXTRA}
    k = hashlib.sha256((json.dumps(body) + (f"#{salt}" if salt is not None else "")).encode()).hexdigest(); p = f"{CACHE}/{k}.json"
    if os.path.exists(p): return json.load(open(p))
    d = 5
    for a in range(10):
        t0 = time.perf_counter()
        try:
            req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions", json.dumps(body).encode(),
                {"content-type": "application/json", "authorization": "Bearer " + KEY, "x-title": "egghead-research"})
            r = json.load(urllib.request.urlopen(req, timeout=180)); ms = (time.perf_counter() - t0) * 1000
            if "choices" not in r: raise OSError(str(r)[:200])
            out = {"id": it["id"], "text": r["choices"][0]["message"].get("content") or "", "ms": ms, "usage": r.get("usage")}
            json.dump(out, open(p, "w")); return out
        except (urllib.error.HTTPError, urllib.error.URLError, OSError, TimeoutError) as e:
            c = getattr(e, "code", None); print("retry", c, file=sys.stderr)
            if c in (400, 401, 402, 403, 404): break; time.sleep(d); d = min(d * 2, 90)
    return {"id": it["id"], "text": "", "ms": None, "usage": None, "error": True}
def parse(t):
    m = re.search(r"\{.*\}", t, re.S)
    try: return json.loads(m.group(0))
    except Exception: return {}
if __name__ == "__main__":
    split = sys.argv[1]; items = load(split)
    if len(sys.argv) > 2: items = items[:int(sys.argv[2])]
    with ThreadPoolExecutor(4) as ex: outs = list(ex.map(call, items))
    P = [parse(o["text"]) for o in outs]
    def bs(pred, gold, sub=items):
        idx = [i for i, it in enumerate(items) if it in sub]
        tp = sum(1 for i in idx if pred(i) and gold(items[i])); fp = sum(1 for i in idx if pred(i) and not gold(items[i])); fn = sum(1 for i in idx if gold(items[i]) and not pred(i))
        a, b, c = prf(tp, fp, fn); return {"P": round(a, 3), "R": round(b, 3), "F1": round(c, 3), "fp": fp, "fn": fn}
    rt = lambda i: (P[i].get("check"), P[i].get("resource")) if P[i].get("is_claim") and P[i].get("check") and P[i].get("resource") not in (None, "unknown") else None
    tp = sum(1 for i, it in enumerate(items) if rt(i) and rt(i) == gold_route(it)); fp = sum(1 for i, it in enumerate(items) if rt(i) and rt(i) != gold_route(it))
    fn = sum(1 for it_i, it in enumerate(items) if gold_route(it) and rt(it_i) != gold_route(it)); a, b, c = prf(tp, fp, fn)
    gate = [it for it in items if it["kind"] == "repo_gate"]
    lat = sorted(o["ms"] for o in outs if o["ms"]); u = [o["usage"] for o in outs if o["usage"]]
    pin = S.mean(x["prompt_tokens"] for x in u); pout = S.mean(x["completion_tokens"] for x in u)
    res = {"model": MODEL, "n": len(items), "parse_fail": sum(1 for x in P if not x), "errors": sum(1 for o in outs if o.get("error")),
           "is_claim": bs(lambda i: bool(P[i].get("is_claim")), lambda it: it["labels"]["is_claim"]),
           "addressed": bs(lambda i: bool(P[i].get("addressed")), lambda it: it["labels"]["addressed_agent"]),
           "routing": {"P": round(a, 3), "R": round(b, 3), "F1": round(c, 3), "fired": tp + fp},
           "speak_gate": bs(lambda i: bool(P[i].get("speak")), lambda it: it["labels"]["should_speak"], gate),
           "latency_ms_p50": round(S.median(lat)), "latency_ms_p95": round(lat[int(0.95 * (len(lat) - 1))]),
           "tokens_in_mean": round(pin), "tokens_out_mean": round(pout),
           "usd_per_line_at_paid_openrouter_price": round(pin * 0.3e-6 + pout * 2.4e-6, 6)}
    print(json.dumps(res, indent=1)); json.dump({"summary": res, "raw": outs}, open(f"{ROOT}/results/llm_baseline_{split}.json", "w"), indent=1)
