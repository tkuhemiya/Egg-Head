"""Best pipeline (choices fixed on dev, see results/PREREGISTERED.json) vs code baselines.
Run on dev to sanity-check, then ONCE on heldout."""
import json, math, os, re, statistics as S, sys

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))
_SPIKE = os.path.join(_REPO_ROOT, "test", "oracles")  # frozen Python reference gate (runtime is TypeScript now)
if _SPIKE not in sys.path:
    sys.path.insert(0, _SPIKE)
from lib import ask_many, load, STATS, prf, ROOT
from common import render, CLAIM_Q, ADDR_Q, FIN_Q, CHECKS, RES, W, alias_hits, gold_route
split = sys.argv[1]
items = load(split)
PL = json.load(open("../results/exp6_platt_dev.json"))
def logit(p): p = min(max(p, 1e-4), 1 - 1e-4); return math.log(p / (1 - p))
def platt(name, p): a, b = PL[name]; return 1 / (1 + math.exp(-(a * logit(p) + b)))
# ---------- stage 1: one batch per utterance ----------
s1 = [(render(it, "kv", 1), {"claim": {"type": "noul", "instructions": CLAIM_Q["short"]},
                             "addr": {"type": "noul", "instructions": ADDR_Q["repo"]}}, "final:s1") for it in items]
r1 = ask_many(s1)
RESI = "Which single named resource is the latest utterance about? Use earlier turns to resolve words like 'it' or 'the database'."
RQU = "unknown: unclear which single resource, or several, or none"
def rot(d, k): ks = list(d); ks = ks[k:] + ks[:k]; return {x: d[x] for x in ks}
plan = []
for it, r in zip(items, r1):
    pc = platt("claim", r["answers"]["claim"]["noul"]); pa = platt("addr", r["answers"]["addr"]["noul"])
    branch = "request" if pa >= 0.5 else "claim" if pc >= 0.5 else "other"
    plan.append({"id": it["id"], "pc": pc, "pa": pa, "branch": branch})
# resource: code pre-pass, else Decider shortlist choice (all rotations averaged)
jobs, need = [], []
for it, p in zip(items, plan):
    if p["branch"] != "claim": continue
    hits = alias_hits(it["latest"]["text"])
    if len(hits) == 1: p["res"], p["rc"] = hits[0], 1.0; continue
    short = hits if hits else ([r for t in it["context"][-2:] for r in alias_hits(t["text"])] or list(RES))
    opts = {**{r: RES[r] for r in dict.fromkeys(short)}, "unknown": RQU}
    for k in range(len(opts)):
        jobs.append((render(it, "kv", 3), {"r": {"type": "choice", "instructions": RESI, "criteria": rot(opts, k)}}, "final:res")); need.append((p["id"], len(opts)))
rr = ask_many(jobs); agg = {}
for (iid, n), r in zip(need, rr):
    for lab, v in r["answers"]["r"]["probabilities"].items(): agg.setdefault(iid, {}).setdefault(lab, 0); agg[iid][lab] += v / n
for p in plan:
    if p["id"] in agg:
        a = agg[p["id"]]; top = max(a, key=a.get); n = len(a); p["res"], p["rc"] = top, (n * a[top] - 1) / (n - 1)
# check: limited to the resource's checks, all rotations averaged
jobs, need = [], []
byid = {it["id"]: it for it in items}
for p in plan:
    if p.get("res") in W["checks"]:
        it = byid[p["id"]]; opts = {c: CHECKS[c] for c in W["checks"][p["res"]]}; opts["none"] = "None of these checks can verify it"
        for k in range(len(opts)):
            jobs.append((render(it, "kv", 3), {"c": {"type": "choice", "instructions": f"Which check would verify what the latest utterance says about {p['res']}?", "criteria": rot(opts, k)}}, "final:check"))
            need.append((p["id"], len(opts)))
rc = ask_many(jobs); agg = {}
for (iid, n), r in zip(need, rc):
    for lab, v in r["answers"]["c"]["probabilities"].items(): agg.setdefault(iid, {}).setdefault(lab, 0); agg[iid][lab] += v / n
T_ROUTE = 0.5
for p in plan:
    if p["id"] in agg:
        a = agg[p["id"]]; top = max(a, key=a.get); n = len(a); cc = (n * a[top] - 1) / (n - 1)
        p["route"] = (top, p["res"]) if top != "none" and min(p["rc"], cc) >= T_ROUTE * 0 + 0.0 and cc >= T_ROUTE * 0.5 else None
        p["score"] = min(p["pc"], p["rc"], cc)
# ---------- baselines ----------
KWC = [(r"cpu|connection|database|\bdb\b", "db_health"), (r"error|5xx|500s|\bdown\b|erroring", "service_error_rate"),
       (r"latency|p99|slow", "latency_p99"), (r"deploy|release|shipped|went out|version", "recent_deploys"),
       (r"alarm", "alarm_state"), (r"queue|backlog|messages", "queue_depth")]
def kw_route(it):
    s = it["latest"]["text"]; hits = alias_hits(s)
    if len(hits) != 1: return None
    for pat, c in KWC:
        if re.search(pat, s, re.I) and c in W["checks"][hits[0]]: return (c, hits[0])
    return None
KWA = re.compile(r"egg ?head|\bassistant\b|\bbot\b", re.I)
def score_routes(pred):
    tp = sum(1 for it in items if pred(it) and pred(it) == gold_route(it)); fp = sum(1 for it in items if pred(it) and pred(it) != gold_route(it))
    fn = sum(1 for it in items if gold_route(it) and pred(it) != gold_route(it)); P, R, F = prf(tp, fp, fn)
    return {"P": round(P, 3), "R": round(R, 3), "F1": round(F, 3), "fired": tp + fp, "gold": sum(1 for it in items if gold_route(it))}
pid = {p["id"]: p for p in plan}
def pipe_route(it):
    p = pid[it["id"]]; r = p.get("route")
    return r if r and p["score"] >= T_ROUTE else None
res = {"routing": {"pipeline": score_routes(pipe_route), "keyword_rule": score_routes(kw_route)}}
def bin_score(pred, gold):
    tp = sum(1 for it in items if pred(it) and gold(it)); fp = sum(1 for it in items if pred(it) and not gold(it)); fn = sum(1 for it in items if gold(it) and not pred(it))
    P, R, F = prf(tp, fp, fn); return {"P": round(P, 3), "R": round(R, 3), "F1": round(F, 3)}
res["addressed"] = {"pipeline": bin_score(lambda it: pid[it["id"]]["pa"] >= 0.5, lambda it: it["labels"]["addressed_agent"]),
                    "keyword_rule": bin_score(lambda it: bool(KWA.search(it["latest"]["text"])), lambda it: it["labels"]["addressed_agent"])}
STATE_W = re.compile(r"\b(is|are|was|isn't|didn't|has|have|looks?|seeing)\b.*\b(fine|normal|healthy|down|slow|up|pegged|erroring|errors?|backing|flat|green|empty|deployed|deploy|went out|shipped|maxed|zero|spiked)\b", re.I)
res["is_claim"] = {"pipeline": bin_score(lambda it: pid[it["id"]]["pc"] >= 0.5, lambda it: it["labels"]["is_claim"]),
                   "keyword_rule": bin_score(lambda it: bool(alias_hits(it["latest"]["text"]) and STATE_W.search(it["latest"]["text"])) or bool(re.search(r"\b(database|db|api|queue)\b", it["latest"]["text"], re.I) and STATE_W.search(it["latest"]["text"])), lambda it: it["labels"]["is_claim"])}
# ---------- speak gate on Egg-Head gate snippets ----------
import egghead_gate as G
gate_items = [it for it in items if it["kind"] == "repo_gate"]
REP = "After the flagged claim, did someone on the call already say it was wrong, or question whether it was right? Agreeing with it is not a correction."
gj = [(render(it, "tagged", 6, pause=True, ledger=True), {"rep": {"type": "noul", "instructions": REP}, "fin": {"type": "noul", "instructions": FIN_Q["repo"]}}, "final:gate") for it in gate_items]
gr = ask_many(gj)
def later_turns(it):
    claim = it["ledger"][0]["claim"].lower()[:20]; ts = it["context"] + [it["latest"]]
    idx = next((i for i, t in enumerate(ts) if t["text"].lower().startswith(claim[:12])), 0)
    return [t["text"] for t in ts[idx + 1:]]
def pipe_speak(it, r):
    led = it["ledger"][0]
    g = G.GateInput(check=led["check"], status="degraded", later_turns=later_turns(it), silence_s=it["pause_s"],
                    self_repaired_p=r["answers"]["rep"]["noul"], interrupt_p=1 - platt("fin", r["answers"]["fin"]["noul"]))
    return G.decide(g).speak
def tally(preds):
    tp = sum(1 for p, it in preds if p and it["labels"]["should_speak"]); fp = sum(1 for p, it in preds if p and not it["labels"]["should_speak"])
    fn = sum(1 for p, it in preds if not p and it["labels"]["should_speak"]); P, R, F = prf(tp, fp, fn)
    return {"P": round(P, 3), "R": round(R, 3), "F1": round(F, 3), "false_interrupts": fp, "missed": fn, "n": len(preds)}
res["speak_gate"] = {"pipeline(egghead gate.py + Decider rep/fin)": tally([(pipe_speak(it, r), it) for it, r in zip(gate_items, gr)]),
                     "silence>=1.5s rule": tally([(it["pause_s"] >= 1.5, it) for it in gate_items]),
                     "always speak when a claim is flagged": tally([(True, it) for it in gate_items])}
# ---------- persistence sequences ----------
seqs = [s for s in json.load(open(f"{ROOT}/data/sequences.json")) if s["split"] == split]
KWR = re.compile(r"\b(wait|hold on|are you sure|not right|not true|doesn't match|actually no|not fine|don't think)\b", re.I)
sj = []
for s in seqs:
    for k in (1, 2, 3):
        ts = s["context"][-2:] + [s["claim"]] + [{"speaker": f["speaker"], "text": f["text"]} for f in s["follow"][:k]]
        st = "Live incident call. The AI assistant is Egg Head.\nTranscript (oldest first):\n" + "\n".join(f"{t['speaker']}: {t['text']}" for t in ts)
        st += f"\nFlagged claim (checked by Egg Head, not yet raised): {s['claim']['speaker']} said \"{s['claim']['text']}\"; the live check on {s['resource']} contradicts it."
        sj.append((st, {"rep": {"type": "noul", "instructions": REP}}, "exp7:persist"))
sr = ask_many(sj)
def sim(det, persist, t):
    fi = miss = good = 0
    for n, s in enumerate(seqs):
        spoke = None; rep = False
        for k in (1, 2, 3):
            if det(n, k) >= t: rep = True
            if rep: break
            if k >= persist: spoke = k; break
        if s["repair_at"] is None: good += spoke is not None; miss += spoke is None
        else: fi += spoke is not None; good += spoke is None
    return {"correct": good, "false_interrupt": fi, "missed": miss, "n": len(seqs)}
dec = lambda n, k: sr[3 * n + k - 1]["answers"]["rep"]["noul"]
kw = lambda n, k: 1.0 if KWR.search(seqs[n]["follow"][k - 1]["text"]) else 0.0
res["persistence"] = {"pipeline decider_or_keyword persist=3 t=0.6 (dev best)": sim(lambda n, k: max(dec(n, k), kw(n, k)), 3, 0.6),
                      "pipeline decider_or_keyword persist=2 t=0.6 (Jarvis tau=2)": sim(lambda n, k: max(dec(n, k), kw(n, k)), 2, 0.6),
                      "keyword only persist=2": sim(kw, 2, 0.5), "keyword only persist=3": sim(kw, 3, 0.5),
                      "speak at once (no persistence)": sim(lambda n, k: 0.0, 1, 0.5)}
lat = [r["latency_ms"] for r in r1]; res["stage1_latency_p50_ms"] = S.median(lat)
res["requests_per_utterance"] = round((len(s1) + len(jobs) + len(need)) / len(items), 2)
res["LLM_every_line_baseline"] = "TODO: no AWS/Bedrock credentials on the box"
print(json.dumps(res, indent=1))
json.dump(res, open(f"../results/final_{split}.json", "w"), indent=1)
print(STATS)
