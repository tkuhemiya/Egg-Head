"""Analyse exp 2+3 rows: position bias, flip rate, mitigation accuracy and ECE; staged noul tree vs N-way choice."""
import json, sys, statistics as S
from collections import defaultdict
from lib import load, ece
from common import UTYPES
split = sys.argv[1] if len(sys.argv) > 1 else "dev"
items = {it["id"]: it for it in load(split)}
rows = json.load(open(f"../results/exp2_{split}.json"))["rows"]
G = defaultdict(dict)
for (iid, dec, style, k), ans, lat in rows:
    G[(iid, dec, style)][k if not isinstance(k, list) else tuple(k)] = ans
def gold(iid, dec):
    l = items[iid]["labels"]
    return {"type": l["utt_type"], "check": l["check"], "asserted": l["asserted"]}[dec]
out = {}
for dec, style in (("type", "def"), ("type", "bare"), ("check", "def"), ("asserted", "def")):
    keys = [k for k in G if k[1] == dec and k[2] == style]
    pos_p = defaultdict(list); flips = []; acc = defaultdict(list); conf_rows = defaultdict(list)
    for key in keys:
        g = gold(key[0], dec); rots = G[key]; n = len(rots)
        tops = []
        for k, ans in rots.items():
            a = list(ans.values())[0]; probs = a["probabilities"]; order = list(probs)
            # the API returns probabilities keyed by label; recover the asked order from the rotation
            labels = list({"type": UTYPES}.get(dec, probs))  # canonical order
            for pos in range(n):
                lab = labels[(pos + k) % n] if dec == "type" else None
            tops.append(a["choice"])
        flips.append(len(set(tops)) > 1)
        # canonical (k=0)
        a0 = list(rots[0].values())[0]
        acc["canonical"].append(a0["choice"] == g); conf_rows["canonical"].append((max(a0["probabilities"].values()), a0["choice"] == g))
        # reverse-ish: average canonical and the rotation furthest away
        def avg(ks):
            p = defaultdict(float)
            for k in ks:
                for lab, v in list(rots[k].values())[0]["probabilities"].items(): p[lab] += v / len(ks)
            top = max(p, key=p.get); return top, p[top]
        for name, ks in (("two_orders", [0, n // 2]), ("all_rotations", list(range(n)))):
            top, pm = avg(ks); acc[name].append(top == g); conf_rows[name].append((pm, top == g))
    m = {name: {"acc": S.mean(v), "ECE": ece(conf_rows[name]), "n": len(v)} for name, v in acc.items()}
    m["top_answer_changes_across_rotations"] = S.mean(flips)
    out[f"{dec}:{style}"] = m
# position bias: probability mass the model gives to whatever option is in position p (type, def)
pos_mass = defaultdict(list)
for key in [k for k in G if k[1] == "type" and k[2] == "def"]:
    labels = list(UTYPES); n = len(labels)
    for k, ans in G[key].items():
        probs = list(ans.values())[0]["probabilities"]
        asked = labels[k:] + labels[:k]
        for pos, lab in enumerate(asked): pos_mass[pos].append(probs[lab])
out["type_mean_prob_by_position"] = [round(S.mean(pos_mass[p]), 3) for p in range(len(UTYPES))]
# noul-per-option and staged tree
labels = list(UTYPES); acc_n, acc_tree, conf_n = [], [], []
for key in [k for k in G if k[1] == "noul"]:
    pass
nk = defaultdict(dict)
for (iid, dec, style), d in G.items():
    if dec != "noul": continue
    for part, ans in d.items():
        for q, a in ans.items(): nk[iid][q[2:]] = a["noul"]
for iid, p in nk.items():
    g = items[iid]["labels"]["utt_type"]; top = max(p, key=p.get)
    acc_n.append(top == g); conf_n.append((p[top] / sum(p.values()), top == g))
    # staged tree (Themiya's first branch): addressed? -> request; else claim? -> claim; else question? ...
    order = ["request_agent", "correction", "claim", "question_humans", "plan_action", "guess", "past", "chitchat"]
    t = next((o for o in order if p[o] >= 0.5), "other"); acc_tree.append(t == g)
out["type:noul_per_option_argmax"] = {"acc": S.mean(acc_n), "ECE": ece(conf_n), "n": len(acc_n)}
out["type:staged_noul_tree_t0.5"] = {"acc": S.mean(acc_tree), "n": len(acc_tree)}
# the claim-vs-not and ask-vs-not branches only (what Egg-Head actually needs)
def branch(pred, g): return ("claim" if pred in ("claim", "correction") else "ask" if pred == "request_agent" else "other") == \
                            ("claim" if g in ("claim", "correction") else "ask" if g == "request_agent" else "other")
b_choice = []; b_noul = []; b_rot = []
for key in [k for k in G if k[1] == "type" and k[2] == "def"]:
    g = items[key[0]]["labels"]["utt_type"]; rots = G[key]
    b_choice.append(branch(list(rots[0].values())[0]["choice"], g))
    p = defaultdict(float)
    for k in rots:
        for lab, v in list(rots[k].values())[0]["probabilities"].items(): p[lab] += v
    b_rot.append(branch(max(p, key=p.get), g))
for iid, p in nk.items():
    g = items[iid]["labels"]["utt_type"]; b_noul.append(branch(max(p, key=p.get), g))
out["branch3_acc"] = {"choice_canonical": S.mean(b_choice), "choice_all_rotations": S.mean(b_rot), "noul_per_option": S.mean(b_noul)}
lat = [r[2] for r in rows]; out["latency_p50_ms"] = S.median(lat)
print(json.dumps(out, indent=1))
json.dump(out, open(f"../results/exp2_{split}_summary.json", "w"), indent=1)
