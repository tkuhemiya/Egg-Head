"""Frozen multi-turn sequences for the persistence / accumulation experiments (author-made).

Each sequence: a false claim, then 3 follow-up turns. Repair happens at turn 1, 2, 3 or never.
Gold per turn k (1..3): repaired_by_k (has someone corrected the claim at or before turn k).
Split by the same 50/50 rule, seed 20261021.
"""
import json, random, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
rng = random.Random(20261021 + 1)
ds = [json.loads(l) for l in open(os.path.join(ROOT, "data/dataset.jsonl"))]
false_claims = [d for d in ds if d["kind"] in ("claim", "claim_context") and d["labels"]["claim_true"] is False]
NEUTRAL = ["Okay, let's keep going.", "I'm pulling up the logs now.", "Who's writing the timeline?", "Let me check the load balancer.",
           "Can someone mute? There's an echo.", "Alright, what's next?", "I'll ping the payments team.", "Let's look at the pods.",
           "Good, so it has to be something else.", "Sam, can you share your screen?", "Okay, noted.", "Let's move on to the API."]
REPAIR = ["Wait, are you sure? I see {r} looking bad on my screen.", "Hold on, that's not right, {r} is in trouble.",
          "Hmm, that doesn't match my dashboard for {r}.", "Actually no, I'm looking at {r} and it's not what you said.",
          "Sorry to jump in, but {r} is definitely not fine.", "I don't think that's true about {r}."]
seqs = []
for i, fc in enumerate(false_claims):
    rep_at = [1, 2, 3, None][i % 4]
    r = fc["labels"]["resource"]
    turns = []
    for k in (1, 2, 3):
        if k == rep_at:
            turns.append({"speaker": rng.choice(["Mei", "Jordan", "Lee"]), "text": rng.choice(REPAIR).format(r=r), "repair": True})
        else:
            turns.append({"speaker": rng.choice(["Priya", "Sam", "Jordan"]), "text": rng.choice(NEUTRAL), "repair": False})
    seqs.append({"id": f"q{i:03d}", "claim_item": fc["id"], "context": fc["context"], "claim": fc["latest"],
                 "resource": r, "check": fc["labels"]["check"], "repair_at": rep_at, "follow": turns,
                 "split": "dev" if (i // 4) % 2 == 0 else "heldout"})  # blocks of 4 so both splits get every repair position
json.dump(seqs, open(os.path.join(ROOT, "data/sequences.json"), "w"), indent=1)
print(len(seqs), sum(s["split"] == "dev" for s in seqs))
