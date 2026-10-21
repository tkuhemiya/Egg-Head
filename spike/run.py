"""Ask Decider every §5 question about every snippet, one batch per snippet.

Two backends:
  --url http://127.0.0.1:8000     a running `strands-decider serve <model> --device mps`
  --checkpoint <hf id or path>    load the model in-process (needs the strands-decider package)

Writes spike/out/results.jsonl (+ meta.json). With --reword q1,q2 it instead asks the
alternate wordings from questions.VARIANTS and writes spike/out/reword.jsonl.
With --dry-run it returns random answers so the pipeline can be tested without the
model; eval.py marks such reports as not real.
"""

from __future__ import annotations

import argparse
import json
import platform
import random
import statistics
import time
import urllib.request
from pathlib import Path

import questions as Q

OUT = Q.HERE / "out"


class HttpBackend:
    def __init__(self, url: str):
        self.url = url.rstrip("/")

    def info(self) -> dict:
        with urllib.request.urlopen(self.url + "/health", timeout=30) as r:
            return {"backend": "http", "url": self.url, "server": json.load(r)}

    def ask(self, state: str, qs: dict) -> tuple[dict, dict]:
        body = json.dumps({"state": state, "questions": qs}).encode()
        req = urllib.request.Request(
            self.url + "/v1/systemone",
            body,
            {
                "content-type": "application/json",
                "user-agent": "egghead-spike/1.0 (+https://github.com/tkuhemiya/Egg-Head)",
            },
        )
        with urllib.request.urlopen(req, timeout=300) as r:
            resp = json.load(r)
        return resp["answers"], resp.get("usage", {})


class LocalBackend:
    def __init__(self, checkpoint: str, device: str):
        from strands_decider.infer import load_engine

        self.checkpoint, self.device = checkpoint, device
        self.engine = load_engine(checkpoint, device=device)

    def info(self) -> dict:
        import torch

        gpu = torch.cuda.get_device_name(0) if torch.cuda.is_available() else None
        return {"backend": "local", "checkpoint": self.checkpoint, "device": self.device,
                "torch": torch.__version__, "gpu": gpu}

    def ask(self, state: str, qs: dict) -> tuple[dict, dict]:
        from strands_decider.schema import SystemOneRequest

        resp = self.engine.evaluate(SystemOneRequest(state=state, questions=qs))
        d = resp.model_dump()
        return d["answers"], d["usage"]


class DryBackend:
    """Random answers with the real response shape. For testing the pipeline only."""

    def __init__(self, seed: int = 0):
        self.rng = random.Random(seed)

    def info(self) -> dict:
        return {"backend": "dry-run"}

    def ask(self, state: str, qs: dict) -> tuple[dict, dict]:
        out = {}
        for name, q in qs.items():
            if q["type"] == "noul":
                out[name] = {"type": "noul", "noul": self.rng.random()}
                continue
            opts = list(q["criteria"])
            w = [self.rng.random() ** 4 for _ in opts]
            p = [x / sum(w) for x in w]
            probs = dict(zip(opts, p))
            if q["type"] == "choice":
                n = len(p)
                out[name] = {"type": "choice", "choice": max(probs, key=probs.get),
                             "probabilities": probs,
                             "confidence": (n * max(p) - 1) / (n - 1)}
            else:
                out[name] = {"type": "score", "score": sum(i * x for i, x in enumerate(p)),
                             "probabilities": {str(i): x for i, x in enumerate(p)},
                             "confidence": self.rng.random()}
        return out, {"input_tokens": len(state) // 4, "output_tokens": len(qs)}


def hardware() -> dict:
    info = {"platform": platform.platform(), "machine": platform.machine(),
            "processor": platform.processor(), "python": platform.python_version()}
    try:
        import os

        info["cpus"] = os.cpu_count()
    except Exception:
        pass
    return info


def timed(backend, state, qs):
    t = time.perf_counter()
    answers, usage = backend.ask(state, qs)
    return answers, usage, (time.perf_counter() - t) * 1000


def main() -> None:
    ap = argparse.ArgumentParser()
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--url")
    src.add_argument("--checkpoint", nargs="?", const=Q.DEFAULT_MODEL)
    src.add_argument("--dry-run", action="store_true")
    ap.add_argument("--device", default="cpu", help="local backend: cpu | mps | cuda")
    ap.add_argument("--hardware-note", default="", help="e.g. 'M4 Pro 24GB, MPS'")
    ap.add_argument("--prefix-check", type=int, default=5,
                    help="also ask each question alone for the first N snippets, to confirm "
                    "the batch reads the state once")
    ap.add_argument("--reword", default="", help="comma-separated question ids to reword-test")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--dataset", default="dataset.jsonl", help="file in spike/")
    ap.add_argument("--out", default="out", help="output dir in spike/")
    args = ap.parse_args()

    if args.url:
        backend = HttpBackend(args.url)
    elif args.dry_run:
        backend = DryBackend()
    else:
        backend = LocalBackend(args.checkpoint, args.device)

    global OUT
    OUT = Q.HERE / args.out
    world = Q.load_world()
    base_qs = Q.build_questions(world)
    snippets = [json.loads(l) for l in (Q.HERE / args.dataset).read_text().splitlines() if l]
    if args.limit:
        snippets = snippets[: args.limit]
    OUT.mkdir(exist_ok=True)

    if args.reword:
        qs = {}
        for qid in args.reword.split(","):
            for i, text in enumerate(Q.VARIANTS[qid]):
                qs[f"{qid}@v{i}"] = {**base_qs[qid], "instructions": text}
        with open(OUT / "reword.jsonl", "w") as f:
            for s in snippets:
                answers, usage, ms = timed(backend, Q.render_state(s), qs)
                f.write(json.dumps({"id": s["id"], "answers": answers, "latency_ms": ms}) + "\n")
        print(f"reworded {list(qs)} over {len(snippets)} snippets -> {OUT / 'reword.jsonl'}")
        return

    # Warm up (weights, kernels, caches) so latency numbers are steady-state.
    for s in snippets[:2]:
        backend.ask(Q.render_state(s), base_qs)

    lat = []
    with open(OUT / "results.jsonl", "w") as f:
        for i, s in enumerate(snippets):
            state = Q.render_state(s)
            answers, usage, ms = timed(backend, state, base_qs)
            lat.append(ms)
            row = {"id": s["id"], "answers": answers, "usage": usage, "latency_ms": ms}
            if i < args.prefix_check:
                singles = [timed(backend, state, {k: v}) for k, v in base_qs.items()]
                row["singles"] = {
                    "latency_ms_sum": sum(x[2] for x in singles),
                    "input_tokens_sum": sum(x[1].get("input_tokens", 0) for x in singles),
                }
            f.write(json.dumps(row) + "\n")
            print(f"{s['id']}: {ms:.0f} ms")

    meta = {"model": getattr(backend, "checkpoint", None) or Q.DEFAULT_MODEL,
            "dry_run": bool(args.dry_run), "questions": list(base_qs), "n": len(snippets),
            "backend": backend.info(), "client_hardware": hardware(),
            "hardware_note": args.hardware_note, "time": time.strftime("%Y-%m-%d %H:%M:%S %z")}
    (OUT / "meta.json").write_text(json.dumps(meta, indent=2))
    print(f"{len(snippets)} snippets, batch p50 {statistics.median(lat):.0f} ms -> {OUT}")


if __name__ == "__main__":
    main()
