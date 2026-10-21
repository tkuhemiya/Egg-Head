"""Exp 5: K paraphrases of the same question, aggregated by mean probability or by vote."""
import json, sys, itertools, statistics as S
from lib import ask_many, load, STATS, full_binary
from common import render
split = sys.argv[1] if len(sys.argv) > 1 else "dev"
items = load(split)
PARA = {
 "claim": ["Does the latest speaker state a fact about the current state of a computer system or service?",
           "Is the latest utterance a statement of how a system or service is behaving right now, or whether it was recently changed?",
           "Does the latest speaker assert something checkable about a system's current health, errors, latency, queue or deploys?",
           "Is the latest utterance a factual claim about live infrastructure, not a guess, plan, question or memory?",
           "Would a dashboard or metric be able to confirm or refute what the latest speaker just said?"],
 "addr": ["Is the LATEST utterance addressed to Egg Head, the AI assistant, rather than to the humans on the call?",
          "Is the latest speaker asking Egg Head (the AI assistant) to do or answer something?",
          "Is the AI assistant the intended listener of the latest utterance?",
          "Is the latest utterance meant for the bot rather than for a person on the call?",
          "Does the latest utterance call on Egg Head, the assistant, by name or role?"]}
gold = {"claim": lambda it: bool(it["labels"]["is_claim"]), "addr": lambda it: bool(it["labels"]["addressed_agent"])}
# each paraphrase in its own request so answers are independent
jobs = [(render(it, "kv", 1), {"q": {"type": "noul", "instructions": p}}, f"exp5:{task}:{k}")
        for task in PARA for k, p in enumerate(PARA[task]) for it in items]
resp = ask_many(jobs)
P = {}; i = 0
for task in PARA:
    for k in range(5):
        P[(task, k)] = [r["answers"]["q"]["noul"] for r in resp[i:i + len(items)]]; i += len(items)
out = {}
for task in PARA:
    g = [gold[task](it) for it in items]
    singles = [full_binary(list(zip(P[(task, k)], g))) for k in range(5)]
    out[task] = {"single": singles}
    for K in (3, 5):
        for combo in [tuple(range(K))]:
            mean = [S.mean(P[(task, k)][n] for k in combo) for n in range(len(items))]
            vote = [S.mean(1.0 if P[(task, k)][n] >= 0.5 else 0.0 for k in combo) for n in range(len(items))]
            out[task][f"mean_K{K}"] = full_binary(list(zip(mean, g)))
            out[task][f"vote_K{K}"] = full_binary(list(zip(vote, g)))
    print(task)
    for k, m in enumerate(singles): print(f"  single{k}  F1@.5 {m['F1']:.2f} AUC {m['AUC']:.3f} ECE {m['ECE']:.3f} bestF1 {m['F1_at_best_t']:.2f}@{m['best_t']}")
    for key in ("mean_K3", "mean_K5", "vote_K3", "vote_K5"):
        m = out[task][key]; print(f"  {key:8s} F1@.5 {m['F1']:.2f} AUC {m['AUC']:.3f} ECE {m['ECE']:.3f} bestF1 {m['F1_at_best_t']:.2f}@{m['best_t']}")
json.dump({"split": split, "metrics": out}, open(f"../results/exp5_{split}.json", "w"), indent=1)
print(STATS)
