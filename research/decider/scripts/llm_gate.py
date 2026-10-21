"""LLM speak-gate v2: a dedicated prompt for the 18 gate items (v1 folded it into the per-line prompt and the model returned speak=null).
Written after seeing v1 heldout fail; checked on dev first, then run once on heldout."""
import json, sys, re
from concurrent.futures import ThreadPoolExecutor
import llm_baseline as L
from lib import load, prf, ROOT
from common import render
L.SYS = """You are Egg Head, an AI assistant listening to a live incident call. Earlier, someone made a claim about a system and your live check shows the claim is wrong (the "Flagged claim" below).
Decide whether to speak up RIGHT NOW to say the live check contradicts it.
Speak if: nobody on the call has already corrected or questioned the claim, and the latest speaker has finished their turn with a natural pause.
Stay quiet if: someone already said the claim was wrong or questioned it, or the latest speaker is mid-sentence or trailing off. Speaking over people is costly, but staying silent while the team acts on a wrong claim is also costly.
Answer with JSON only: {"speak": true} or {"speak": false}"""
split = sys.argv[1]; items = [it for it in load(split) if it["kind"] == "repo_gate"]
with ThreadPoolExecutor(4) as ex: outs = list(ex.map(L.call, items))
P = [L.parse(o["text"]).get("speak") for o in outs]
tp = sum(1 for p, it in zip(P, items) if p and it["labels"]["should_speak"]); fp = sum(1 for p, it in zip(P, items) if p and not it["labels"]["should_speak"])
fn = sum(1 for p, it in zip(P, items) if not p and it["labels"]["should_speak"]); a, b, c = prf(tp, fp, fn)
lat = sorted(o["ms"] for o in outs if o["ms"])
res = {"n": len(items), "P": round(a, 3), "R": round(b, 3), "F1": round(c, 3), "false_interrupts": fp, "missed": fn, "null": sum(p is None for p in P), "p50_ms": round(lat[len(lat)//2])}
print(res); json.dump({"summary": res, "raw": outs}, open(f"{ROOT}/results/llm_gate_{split}.json", "w"), indent=1)
