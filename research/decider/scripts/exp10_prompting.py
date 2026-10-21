"""Exp 10: prompt-engineering techniques for Decider (dev tuning; `heldout` arg runs the frozen choice once).
Techniques: definition-in-question, contrastive framing, negated question pairs, persona prefix, contextual calibration
(content-free prior), paraphrase ensembles; option wording for the check choice; contrastive repair question for the gate."""
import json, sys, math, statistics as S
sys.path.insert(0, "/tmp/eh")
from lib import ask_many, load, auc, ROOT, binary_metrics_at, best_threshold
from common import render, CLAIM_Q, CHECKS, W, gold_route
split = sys.argv[1]; items = load(split)
def lg(p): p = min(max(p, 1e-4), 1 - 1e-4); return math.log(p / (1 - p))
sig = lambda z: 1 / (1 + math.exp(-z))
CQ = {"short": CLAIM_Q["short"],
 "defn": "A claim is something said as a fact about how a system, service, metric or deploy is right now. Does the latest utterance make a claim?",
 "contrast": "Is the latest speaker stating as fact how a system is right now, rather than guessing, asking, planning, or describing the past?",
 "persona": "You are a senior site reliability engineer on this call. " + CLAIM_Q["short"],
 "neg": "Is the latest utterance something other than a factual statement about the current state of a system, such as a guess, a question, a plan, or small talk?"}
y = [it["labels"]["is_claim"] for it in items]
R = ask_many([(render(it, "kv", 1), {k: {"type": "noul", "instructions": v} for k, v in CQ.items()}, "exp10:claim") for it in items])
L = {k: [lg(r["answers"][k]["noul"]) for r in R] for k in CQ}
L["negpair"] = [(a - b) / 2 for a, b in zip(L["short"], L["neg"])]
L["ens3"] = [(a + b + c) / 3 for a, b, c in zip(L["short"], L["defn"], L["contrast"])]
L["ens3+neg"] = [(a + b + c - d) / 4 for a, b, c, d in zip(L["short"], L["defn"], L["contrast"], L["neg"])]
# contextual calibration (Zhao et al. 2021): prior from content-free inputs, no labels needed
CF = ["N/A", "", "[MASK]"]
cfs = ask_many([(f"setting: live group call; AI assistant name: Egg Head\nprevious_turns: (none)\nlatest_speaker: Speaker\nlatest_utterance: {c}",
                 {k: {"type": "noul", "instructions": v} for k, v in CQ.items()}, "exp10:cf") for c in CF])
prior = {k: S.mean(lg(r["answers"][k]["noul"]) for r in cfs) for k in CQ}
out = {"n": len(items), "cf_prior_logit": prior, "claim": {}}
for k, v in L.items():
    pr = list(zip([sig(x) for x in v], y)); m = {"AUC": round(auc(pr), 3), "raw@0.5": binary_metrics_at(pr, 0.5)}
    if k in prior: m["cc@0.5"] = binary_metrics_at([(sig(x - prior[k]), g) for x, g in zip(v, y)], 0.5)
    if split == "dev": t = best_threshold(pr); m["best_t"] = binary_metrics_at(pr, t)
    out["claim"][k] = m
# check option wording, given gold resource (isolates the check step)
def rot(d, k): ks = list(d); ks = ks[k:] + ks[:k]; return {x: d[x] for x in ks}
CLAIMY = {"db_health": "Claims that a database is fine, slow, overloaded, out of connections or at high CPU",
          "service_error_rate": "Claims that a service is erroring, failing, throwing 500s, up or down",
          "latency_p99": "Claims that a service is fast, slow or timing out",
          "recent_deploys": "Claims that something was or wasn't deployed, released or changed recently",
          "alarm_state": "Claims about which alarms are firing or that nothing is alarming",
          "queue_depth": "Claims that a queue is backed up, draining or empty"}
OPTS = {"desc": CHECKS, "claimy": CLAIMY, "names": {c: c.replace("_", " ") for c in CHECKS}}
gi = [it for it in items if gold_route(it)]
out["check_acc"] = {}
for name, od in OPTS.items():
    jobs, need = [], []
    for it in gi:
        res = gold_route(it)[1]; o = {c: od[c] for c in W["checks"][res]}; o["none"] = "None of these checks can verify it"
        for k in range(len(o)):
            jobs.append((render(it, "kv", 3), {"c": {"type": "choice", "instructions": f"Which check would verify what the latest utterance says about {res}?", "criteria": rot(o, k)}}, "exp10:check")); need.append((it["id"], len(o)))
    agg = {}
    for (iid, n), x in zip(need, ask_many(jobs)):
        for lab, v in x["answers"]["c"]["probabilities"].items(): agg.setdefault(iid, {}).setdefault(lab, 0); agg[iid][lab] += v / n
    out["check_acc"][name] = round(S.mean(max(agg[it["id"]], key=agg[it["id"]].get) == gold_route(it)[0] for it in gi), 3)
# repair question for the speak gate
from egghead import gate as G
from final_platt import platt
REPQ = {"base": "After the flagged claim, did someone on the call already say it was wrong, or question whether it was right? Agreeing with it is not a correction.",
        "contrast": "After the flagged claim, did anyone doubt, question or contradict it, as opposed to agreeing with it, building on it or changing the subject?",
        "neg": "After the flagged claim, did everyone who spoke accept it or move on without questioning it?"}
gate = [it for it in items if it["kind"] == "repo_gate"]
gr = ask_many([(render(it, "tagged", 6, pause=True, ledger=True), {**{k: {"type": "noul", "instructions": v} for k, v in REPQ.items()},
               "fin": {"type": "noul", "instructions": "Has the latest speaker finished their turn, so that someone else could start talking now?"}}, "exp10:gate") for it in gate])
def later(it):
    c = it["ledger"][0]["claim"].lower(); ts = it["context"] + [it["latest"]]
    i = next((i for i, t in enumerate(ts) if t["text"].lower().startswith(c[:12])), 0); return [t["text"] for t in ts[i + 1:]]
out["gate"] = {}
for k in list(REPQ) + ["negpair"]:
    rp = [r["answers"][k]["noul"] for r in gr] if k != "negpair" else [sig((lg(r["answers"]["base"]["noul"]) - lg(r["answers"]["neg"]["noul"])) / 2) for r in gr]
    if k == "neg": rp = [1 - p for p in rp]
    sp = [G.decide(G.GateInput(check=it["ledger"][0]["check"], status="degraded", later_turns=later(it), silence_s=it["pause_s"],
          self_repaired_p=p, interrupt_p=1 - platt("fin", r["answers"]["fin"]["noul"]))).speak for it, p, r in zip(gate, rp, gr)]
    tp = sum(s and it["labels"]["should_speak"] for s, it in zip(sp, gate)); fp = sum(s and not it["labels"]["should_speak"] for s, it in zip(sp, gate)); fn = sum((not s) and it["labels"]["should_speak"] for s, it in zip(sp, gate))
    out["gate"][k] = {"repair_AUC": round(auc(list(zip(rp, [bool(it["labels"]["self_repaired"]) for it in gate]))), 3), "F1": round(2 * tp / (2 * tp + fp + fn), 3) if tp else 0, "false_interrupts": fp, "missed": fn}
json.dump(out, open(f"{ROOT}/results/exp10_{split}.json", "w"), indent=1)
for k, v in out["claim"].items(): print("claim", k, v["AUC"], "raw", round(v["raw@0.5"]["F1"], 3), "cc", round(v.get("cc@0.5", {}).get("F1", float("nan")), 3), "best", v.get("best_t"))
print("prior", prior); print("check", out["check_acc"]); print("gate", out["gate"])
