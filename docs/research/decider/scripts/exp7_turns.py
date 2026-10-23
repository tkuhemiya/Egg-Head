"""Exp 7: turn-taking. End-of-turn text-only vs with pause; would-interrupt; addressee vs keyword rule;
Jarvis-style persistence (act only if the error survives N turns) on frozen sequences."""
import json, sys, re, statistics as S
from lib import ask_many, load, STATS, full_binary, ROOT
from common import render, FIN_Q, INT_Q, ADDR_Q
split = sys.argv[1] if len(sys.argv) > 1 else "dev"
items = load(split)
jobs = []
for it in items:
    for pause in (False, True):
        jobs.append((render(it, "tagged", 1, pause=pause), {"fin": {"type": "noul", "instructions": FIN_Q["repo"]},
                     "int": {"type": "noul", "instructions": INT_Q["repo"]}}, f"exp7:eot:pause={pause}"))
resp = ask_many(jobs)
out = {}
for j, pause in enumerate((False, True)):
    rs = resp[j::2]
    out[f"fin_pause={pause}"] = full_binary([(r["answers"]["fin"]["noul"], bool(it["labels"]["turn_finished"])) for r, it in zip(rs, items)])
    out[f"int_pause={pause}"] = full_binary([(r["answers"]["int"]["noul"], bool(it["labels"]["would_interrupt"])) for r, it in zip(rs, items)])
# code baselines
out["fin_rule_pause>=0.5s"] = full_binary([(1.0 if it["pause_s"] >= 0.5 else 0.0, bool(it["labels"]["turn_finished"])) for it in items])
TRAIL = re.compile(r"(\b(the|a|and|then|but|because|if|that|to|is|are|of|on|uh|so)\s*,?\s*$)|,\s*$", re.I)
out["fin_rule_trailing_word"] = full_binary([(0.0 if TRAIL.search(it["latest"]["text"]) else 1.0, bool(it["labels"]["turn_finished"])) for it in items])
out["int_rule_trailing_word"] = full_binary([(1.0 if TRAIL.search(it["latest"]["text"]) else 0.0, bool(it["labels"]["would_interrupt"])) for it in items])
KW = re.compile(r"egg ?head|\bassistant\b|\bbot\b", re.I)
out["addr_rule_keyword"] = full_binary([(1.0 if KW.search(it["latest"]["text"]) else 0.0, bool(it["labels"]["addressed_agent"])) for it in items])
for k, m in out.items(): print(f"{k:26s} F1@.5 {m['F1']:.2f} AUC {m['AUC']:.3f} ECE {m['ECE']:.3f} bestF1 {m['F1_at_best_t']:.2f}@{m['best_t']}")
print("unfinished share", round(1 - S.mean(bool(it["labels"]["turn_finished"]) for it in items), 3),
      "| pause mean finished", round(S.mean(it["pause_s"] for it in items if it["labels"]["turn_finished"]), 2),
      "unfinished", round(S.mean(it["pause_s"] for it in items if not it["labels"]["turn_finished"]), 2))

# --- persistence on sequences -----------------------------------------------------------
seqs = [s for s in json.load(open(f"{ROOT}/data/sequences.json")) if s["split"] == split]
REP = "After the flagged claim, did someone on the call already say it was wrong, or question whether it was right? Agreeing with it is not a correction."
KWR = re.compile(r"\b(wait|hold on|are you sure|not right|not true|doesn't match|actually no|not fine|don't think)\b", re.I)
sj = []
for s in seqs:
    for k in (1, 2, 3):
        ts = s["context"][-2:] + [s["claim"]] + [{"speaker": f["speaker"], "text": f["text"]} for f in s["follow"][:k]]
        st = "Live incident call. The AI assistant is Egg Head.\nTranscript (oldest first):\n" + "\n".join(f"{t['speaker']}: {t['text']}" for t in ts)
        st += f"\nFlagged claim (checked by Egg Head, not yet raised): {s['claim']['speaker']} said \"{s['claim']['text']}\"; the live check on {s['resource']} contradicts it."
        sj.append((st, {"rep": {"type": "noul", "instructions": REP}}, "exp7:persist"))
sr = ask_many(sj)
def simulate(detect, persist, t=0.5):
    fi = miss = good = 0; waits = []
    for n, s in enumerate(seqs):
        spoke = None; repaired = False
        for k in (1, 2, 3):
            if detect(n, k) >= t: repaired = True
            if repaired: break
            if k >= persist: spoke = k; break
        if s["repair_at"] is None:
            if spoke: good += 1; waits.append(spoke)
            else: miss += 1
        else:
            if spoke is not None: fi += 1
            else: good += 1
    return {"correct": good, "false_interrupt": fi, "missed": miss, "n": len(seqs), "median_turns_waited": S.median(waits) if waits else None}
dec = lambda n, k: sr[3 * n + k - 1]["answers"]["rep"]["noul"]
def kw(n, k): return 1.0 if KWR.search(seqs[n]["follow"][k - 1]["text"]) else 0.0
gold_rep = [(dec(n, k), any(f["repair"] for f in seqs[n]["follow"][:k])) for n in range(len(seqs)) for k in (1, 2, 3)]
out["self_repaired_decider"] = full_binary(gold_rep)
out["persist"] = {}
def rolling(n, k, decay=0.5):
    # Cooloff-style rolling evidence: decayed sum of per-turn repair probabilities so far
    return sum(dec(n, j) * decay ** (k - j) for j in range(1, k + 1))
for name, det in (("decider", dec), ("keyword", kw), ("decider_or_keyword", lambda n, k: max(dec(n, k), kw(n, k))), ("decider_rolling", rolling)):
    for p in (1, 2, 3):
        for t in ((0.44, 0.5, 0.6) if name.startswith("decider") else (0.5,)):
            out["persist"][f"{name}_persist{p}_t{t}"] = r = simulate(det, p, t); print(f"{name:20s} persist={p} t={t}: {r}")
m = out["self_repaired_decider"]; print(f"self_repaired decider F1@.5 {m['F1']:.2f} AUC {m['AUC']:.3f} bestF1 {m['F1_at_best_t']:.2f}@{m['best_t']}")
json.dump({"split": split, "metrics": out}, open(f"../results/exp7_{split}.json", "w"), indent=1)
print(STATS)
