"""Score spike/out/results.jsonl against the labels and write spike/REPORT.md."""

from __future__ import annotations

import json
import statistics
from collections import defaultdict

import questions as Q

OUT = Q.HERE / "out"
BINS = [0.0, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0001]


def read_jsonl(path):
    return [json.loads(l) for l in path.read_text().splitlines() if l] if path.exists() else []


def predict(qtype: str, ans: dict, invert: bool = False):
    """-> (prediction, confidence used for the >=0.9 gate, probability of the prediction)."""
    if qtype == "noul":
        p = 1 - ans["noul"] if invert else ans["noul"]
        return p >= 0.5, max(p, 1 - p), max(p, 1 - p)
    if qtype == "choice":
        c = ans["choice"]
        return c, ans["confidence"], ans["probabilities"][c]
    level = min(len(Q.SILENCE_COST) - 1, max(0, round(ans["score"])))
    probs = list(ans["probabilities"].values())
    return level, ans["confidence"], probs[level]


def pct(x):
    return "—" if x is None else f"{100 * x:.0f}%"


def ratio(a, b):
    return None if b == 0 else a / b


def score_questions(snips, results, qtypes, key=lambda q: q, invert=lambda q: False):
    """Per-question rows: list of (id, label, pred, conf, prob, correct, tricky)."""
    rows = defaultdict(list)
    for s in snips:
        r = results.get(s["id"])
        if not r:
            continue
        for qname, ans in r["answers"].items():
            base = qname.split("@")[0]
            label = s["labels"].get(base)
            if label is None:
                continue
            pred, conf, prob = predict(qtypes[base], ans, invert(qname))
            ok = pred == label
            rows[key(qname)].append((s["id"], label, pred, conf, prob, ok, s["tricky"]))
    return rows


def acc_table(rows):
    out = ["| question | n | accuracy | tricky acc | acc @ conf ≥ 0.9 | coverage @ 0.9 |",
           "|---|---|---|---|---|---|"]
    summary = {}
    for q, rs in rows.items():
        n = len(rs)
        acc = ratio(sum(r[5] for r in rs), n)
        tr = [r for r in rs if r[6]]
        hi = [r for r in rs if r[3] >= 0.9]
        acc_hi = ratio(sum(r[5] for r in hi), len(hi))
        cov = ratio(len(hi), n)
        summary[q] = (acc, acc_hi, cov)
        out.append(f"| `{q}` | {n} | {pct(acc)} | {pct(ratio(sum(r[5] for r in tr), len(tr)))} "
                   f"| {pct(acc_hi)} | {pct(cov)} |")
    return out, summary


def calibration(rows):
    pooled = [r for rs in rows.values() for r in rs]
    out = ["| P(predicted) | n | mean P | accuracy |", "|---|---|---|---|"]
    ece = 0.0
    for lo, hi in zip(BINS, BINS[1:]):
        b = [r for r in pooled if lo <= r[4] < hi]
        if not b:
            continue
        mp = statistics.mean(r[4] for r in b)
        acc = sum(r[5] for r in b) / len(b)
        ece += len(b) / len(pooled) * abs(mp - acc)
        out.append(f"| {lo:.2f}–{min(hi, 1):.2f} | {len(b)} | {mp:.2f} | {pct(acc)} |")
    out.append(f"\nExpected calibration error (pooled, {len(pooled)} answers): **{ece:.3f}**")
    return out


def prf(pairs):
    tp = sum(p and l for p, l in pairs)
    fp = sum(p and not l for p, l in pairs)
    fn = sum(l and not p for p, l in pairs)
    return tp, fp, fn, ratio(tp, tp + fp), ratio(tp, tp + fn)


def main() -> None:
    world = Q.load_world()
    qdefs = Q.build_questions(world)
    qtypes = {k: v["type"] for k, v in qdefs.items()}
    snips = [json.loads(l) for l in (Q.HERE / "dataset.jsonl").read_text().splitlines() if l]
    results = {r["id"]: r for r in read_jsonl(OUT / "results.jsonl")}
    if not results:
        raise SystemExit("no spike/out/results.jsonl — run run.py first")
    meta = json.loads((OUT / "meta.json").read_text()) if (OUT / "meta.json").exists() else {}
    snips = [s for s in snips if s["id"] in results]
    by_id = {s["id"]: s for s in snips}

    md = ["# Spike report: Decider go/no-go", ""]
    if meta.get("dry_run"):
        md += ["> **DRY RUN — random answers, not model output. Numbers below mean nothing.**", ""]
    md += [f"- Model: `{meta.get('model')}`", f"- Run: {meta.get('time')}",
           f"- Snippets: {len(snips)} ({sum(bool(s['ledger']) for s in snips)} with an open flagged claim)",
           f"- Backend: `{json.dumps(meta.get('backend'))}`",
           f"- Client hardware: `{json.dumps(meta.get('client_hardware'))}`"]
    if meta.get("hardware_note"):
        md.append(f"- Hardware note: {meta['hardware_note']}")
    md.append("")

    def invert_q(qname: str) -> bool:
        if qname == "floor_free" and Q.FLOOR_INVERT:
            return True
        if "@v" in qname:
            base, _, rest = qname.partition("@v")
            try:
                return (base, int(rest)) in Q.INVERTED
            except ValueError:
                return False
        return False

    # 1-2. Per-question accuracy and high-confidence slice.
    # Patch labels in a shallow copy so scoring sees mapped gold.
    snips_scored = []
    for s in snips:
        lab = dict(s["labels"])
        if qtypes.get("silence_cost") == "noul" and isinstance(lab.get("silence_cost"), int):
            lab["silence_cost"] = lab["silence_cost"] >= Q.SILENCE_COST_NOUL_AT
        snips_scored.append({**s, "labels": lab})
    rows = score_questions(snips_scored, results, qtypes, invert=invert_q)
    table, summary = acc_table(rows)
    md += ["## 1. Per-question accuracy", "",
           "Confidence: noul = max(p, 1−p); choice = (N·p_max−1)/(N−1); score = the ordinal "
           "confidence the server returns. Pass-2 `silence_cost` is noul (gold = level ≥ moderate). "
           "Pass-2 `floor_free` is asked as 'would speaking interrupt?' and inverted.",
           "", *table, ""]

    # 3. Calibration.
    md += ["## 2. Calibration (all questions pooled)", "", *calibration(rows), ""]

    # 4. Routing gate and end-to-end contradiction detection.
    route = []
    contra_ok = contra_n = 0
    for s in snips:
        a, lab = results[s["id"]]["answers"], s["labels"]
        checkable = (lab["is_claim"] and lab["which_check"] not in (None, "none")
                     and lab["which_resource"] not in (None, "unknown")
                     and Q.lookup(world, lab["which_resource"], lab["which_check"]) is not None)
        fired = Q.route_gate(a)
        right = (fired and checkable and a["which_check"]["choice"] == lab["which_check"]
                 and a["which_resource"]["choice"] == lab["which_resource"])
        route.append((s["id"], fired, checkable, right))
        if fired:
            res = Q.lookup(world, a["which_resource"]["choice"], a["which_check"]["choice"])
            pred_v = Q.compare(a["asserted_state"]["choice"], res and res["status"])
            gold = Q.lookup(world, lab["which_resource"], lab["which_check"])
            gold_v = Q.compare(lab["asserted_state"], gold and gold["status"]) if checkable else "none"
            contra_n += 1
            contra_ok += pred_v == gold_v
    fires = sum(r[1] for r in route)
    n_checkable = sum(r[2] for r in route)
    right = sum(r[3] for r in route)
    wrong_fires = [r[0] for r in route if r[1] and not r[3]]
    md += ["## 3. Check routing gate (§5.3 'run check')", "",
           f"- Fired on {fires} of {len(route)} snippets; {n_checkable} snippets hold a checkable claim.",
           f"- Precision (fired with the right check and resource): **{pct(ratio(right, fires))}** ({right}/{fires})",
           f"- Recall over checkable claims: **{pct(ratio(right, n_checkable))}** ({right}/{n_checkable})",
           f"- Verdict (supports / contradicts / inconclusive) matches gold on {contra_ok}/{contra_n} fired checks",
           f"- Wrong fires: {', '.join(wrong_fires) or 'none'}", ""]

    # 5. Speak gate on snippets with an open flagged claim.
    speak = []
    for s in snips:
        if not s["ledger"]:
            continue
        a = results[s["id"]]["answers"]
        speak.append((s["id"], Q.speak_gate(a, s["silence_s"]), s["labels"]["should_speak"], a))
    tp, fp, fn, p, r = prf([(x[1], x[2]) for x in speak])
    md += ["## 4. Speak gate (§5.3 'speak', snippets with an open flagged claim)", "",
           f"- Precision **{pct(p)}**, recall **{pct(r)}** (TP {tp}, FP {fp}, FN {fn}, n {len(speak)})",
           f"- Thresholds: T_ROUTE={Q.T_ROUTE}, T_SELF_REPAIRED={Q.T_SELF_REPAIRED}, "
           f"T_FLOOR={Q.T_FLOOR} (FLOOR_INVERT={Q.FLOOR_INVERT}), T_SILENCE_S={Q.T_SILENCE_S}s, "
           f"T_COST={Q.T_COST}",
           "", "| id | gold | gate | self_repaired | floor_free | silence s | silence_cost |",
           "|---|---|---|---|---|---|---|"]
    for sid, pred, gold, a in speak:
        flag = "" if pred == gold else " ❌"
        md.append(f"| {sid}{flag} | {'speak' if gold else 'quiet'} | {'speak' if pred else 'quiet'} "
                  f"| {a['self_repaired']['noul']:.2f} | {Q.floor_free_p(a):.2f} "
                  f"| {by_id[sid]['silence_s']} | {Q.silence_cost_p(a):.2f} |")
    md.append("")

    # 6. Latency.
    lat = sorted(r["latency_ms"] for r in results.values())
    p95 = lat[min(len(lat) - 1, int(round(0.95 * (len(lat) - 1))))]
    md += ["## 5. Latency (one batch of all questions per snippet)", "",
           f"- p50 **{statistics.median(lat):.0f} ms**, p95 **{p95:.0f} ms**, "
           f"max {lat[-1]:.0f} ms over {len(lat)} snippets ({len(qdefs)} questions each)"]
    pc = [r for r in results.values() if "singles" in r]
    if pc:
        b = statistics.mean(r["latency_ms"] for r in pc)
        s1 = statistics.mean(r["singles"]["latency_ms_sum"] for r in pc)
        tb = statistics.mean(r["usage"].get("input_tokens", 0) for r in pc)
        ts = statistics.mean(r["singles"]["input_tokens_sum"] for r in pc)
        md.append(f"- State read once? On {len(pc)} snippets: batch {b:.0f} ms vs {s1:.0f} ms for the "
                  f"same questions asked one by one ({s1 / b:.1f}×); input tokens {tb:.0f} vs {ts:.0f}.")
    md += ["- Latency only counts on the target machine; re-measure on the M4 if this ran elsewhere.", ""]

    # 7. Rewording.
    rew = {r["id"]: r for r in read_jsonl(OUT / "reword.jsonl")}
    worst = sorted(summary, key=lambda q: (summary[q][0] or 0))[:3]
    md += ["## 6. Rewording test", ""]
    if rew:
        rrows = score_questions(snips_scored, rew, qtypes, invert=invert_q)
        t, _ = acc_table({**{f"{q.split('@')[0]} (base)": rows[q.split("@")[0]] for q in rrows}, **rrows})
        md += t
        md += ["", "Variant wording: see `questions.VARIANTS`."]
    else:
        md.append(f"Not run yet. Worst three: `python spike/run.py ... --reword {','.join(worst)}` then re-run eval.")
    md.append("")

    # 8. Errors, for rewording and threshold work.
    md += ["## 7. Errors", "", "| question | id | gold | predicted | conf |", "|---|---|---|---|---|"]
    for q, rs in rows.items():
        for sid, label, pred, conf, _, ok, _ in rs:
            if not ok:
                md.append(f"| `{q}` | {sid} | {label} | {pred} | {conf:.2f} |")
    md.append("")

    # 9. Suggested verdict. Thresholds are ours, set before the run.
    routing = ["is_claim", "which_check", "which_resource", "asserted_state"]
    hi_acc = [summary[q][1] for q in routing if summary.get(q) and summary[q][1] is not None]
    route_p = ratio(right, fires)
    if hi_acc and min(hi_acc) >= 0.9 and (route_p or 0) >= 0.9 and (p or 0) >= 0.8:
        verdict = "GO"
    elif not hi_acc or min(hi_acc) < 0.75 or (route_p or 0) < 0.75:
        verdict = "NO-GO"
    else:
        verdict = "GO-with-changes"
    md += ["## 8. Suggested verdict", "",
           f"**{verdict}** (rule: GO if every routing question is ≥ 90% accurate at confidence ≥ 0.9, "
           "routing-gate precision ≥ 90% and speak-gate precision ≥ 80%; NO-GO if any of the first two is "
           "below 75%; otherwise GO-with-changes). Pass 1 showed conf ≥ 0.9 is mostly empty on these "
           "noul questions, so the human call should also look at routing-gate precision at T_ROUTE and "
           "speak-gate precision. Record the call in NextSteps.md.", ""]
    if meta.get("dry_run"):
        md.insert(2, "> Verdict below is computed from random answers. Ignore it.\n")

    (Q.HERE / "REPORT.md").write_text("\n".join(md))
    print(f"wrote {Q.HERE / 'REPORT.md'} — suggested verdict {verdict}")


if __name__ == "__main__":
    main()
