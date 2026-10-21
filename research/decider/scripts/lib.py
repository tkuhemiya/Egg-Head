"""Shared client for the free public Decider API, with a disk cache and a raw log.

Every request+response is appended to results/raw.jsonl. Identical requests are served
from results/cache/ so reruns cost nothing. Concurrency is kept low (default 3) and
errors back off, because the API is a best-effort free preview.
"""
import hashlib, json, os, threading, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
URL = "https://api.decider.cloud/v1/systemone"
MODEL = "strands-decider-2b"
UA = "egghead-decider-research/0.1 (hackathon research; contact via github tkuhemiya)"
CACHE = os.path.join(ROOT, "results", "cache"); os.makedirs(CACHE, exist_ok=True)
RAW = os.path.join(ROOT, "results", "raw.jsonl")
_lock = threading.Lock()
STATS = {"network": 0, "cached": 0, "errors": 0}

def _key(payload):
    # key keeps dict order: option order is part of the request (sorting keys would merge rotations)
    return hashlib.sha256(json.dumps(payload).encode()).hexdigest()

def ask(state, questions, tag=""):
    payload = {"model": MODEL, "state": state, "questions": questions}
    k = _key(payload); p = os.path.join(CACHE, k + ".json")
    if os.path.exists(p):
        STATS["cached"] += 1
        return json.load(open(p))
    delay = 2.0
    for attempt in range(7):
        t0 = time.perf_counter()
        try:
            req = urllib.request.Request(URL, json.dumps(payload).encode(),
                                         {"content-type": "application/json", "user-agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                resp = json.load(r)
            rtt = (time.perf_counter() - t0) * 1000
            out = {"answers": resp["answers"], "latency_ms": resp.get("latency_ms"),
                   "rtt_ms": rtt, "usage": resp.get("usage"), "model": resp.get("model")}
            with _lock:
                json.dump(out, open(p, "w"))
                with open(RAW, "a") as f:
                    f.write(json.dumps({"ts": time.time(), "tag": tag, "key": k,
                                        "request": payload, "response": out}) + "\n")
                STATS["network"] += 1
            return out
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError) as e:
            STATS["errors"] += 1
            code = getattr(e, "code", None)
            if code in (400, 404, 422):
                raise
            time.sleep(delay); delay = min(delay * 2, 60)
    raise RuntimeError("Decider API failed after retries")

def ask_many(jobs, workers=2):
    """jobs: list of (state, questions, tag). Returns list of responses in order."""
    with ThreadPoolExecutor(workers) as ex:
        return list(ex.map(lambda j: ask(*j), jobs))

def load(split=None):
    items = [json.loads(l) for l in open(os.path.join(ROOT, "data", "dataset.jsonl"))]
    if split:
        items = [i for i in items if i["split"] == split]
    return items

def choice_conf(probs):
    n = len(probs); m = max(probs.values())
    return (n * m - 1) / (n - 1) if n > 1 else 1.0

def prf(tp, fp, fn):
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    f = 2 * p * r / (p + r) if p + r else 0.0
    return p, r, f

def binary_metrics(pairs, t=0.5):
    """pairs: list of (prob_true, gold_bool)."""
    tp = sum(1 for p, g in pairs if p >= t and g); fp = sum(1 for p, g in pairs if p >= t and not g)
    fn = sum(1 for p, g in pairs if p < t and g)
    acc = sum(1 for p, g in pairs if (p >= t) == g) / len(pairs)
    P, R, F = prf(tp, fp, fn)
    return {"n": len(pairs), "acc": acc, "P": P, "R": R, "F1": F, "ECE": ece_binary(pairs)}

def ece_binary(pairs, bins=10):
    """ECE of the predicted label's confidence max(p,1-p) vs its correctness."""
    rows = [(max(p, 1 - p), (p >= 0.5) == g) for p, g in pairs]
    return ece(rows, bins)

def ece(rows, bins=10):
    """rows: list of (confidence in [0,1] of the predicted answer, correct bool)."""
    if not rows: return 0.0
    tot = 0.0
    for b in range(bins):
        lo, hi = b / bins, (b + 1) / bins
        s = [r for r in rows if lo <= r[0] < hi or (b == bins - 1 and r[0] == 1.0)]
        if s:
            tot += len(s) / len(rows) * abs(sum(r[0] for r in s) / len(s) - sum(r[1] for r in s) / len(s))
    return tot

def auc(pairs):
    pos = [p for p, g in pairs if g]; neg = [p for p, g in pairs if not g]
    if not pos or not neg: return float("nan")
    s = sum((1 if a > b else 0.5 if a == b else 0) for a in pos for b in neg)
    return s / (len(pos) * len(neg))

def best_threshold(pairs):
    best = (0, 0.5)
    for t in [i / 100 for i in range(5, 96)]:
        F = binary_metrics_at(pairs, t)["F1"]
        if F > best[0]: best = (F, t)
    return best[1]

def binary_metrics_at(pairs, t):
    tp = sum(1 for p, g in pairs if p >= t and g); fp = sum(1 for p, g in pairs if p >= t and not g)
    fn = sum(1 for p, g in pairs if p < t and g)
    P, R, F = prf(tp, fp, fn)
    return {"t": t, "P": P, "R": R, "F1": F, "acc": sum(1 for p, g in pairs if (p >= t) == g) / len(pairs)}

def full_binary(pairs):
    m = binary_metrics(pairs); m["AUC"] = auc(pairs)
    bt = best_threshold(pairs); m["best_t"] = bt; m["F1_at_best_t"] = binary_metrics_at(pairs, bt)["F1"]
    return m
