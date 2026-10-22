# Next Steps

Status as of Thu 22 Oct 2026. **Scope reminder:** the project is the turn-taking / when-to-speak / what-action-to-take decision pattern; the incident call is only the demo.

## 00. Router = research pipeline, live demo (Thu 22 Oct, later)

- **Router:** the runtime now asks the frozen research pipeline (exp 9 + final_eval) instead of the pass-2 questions. `npm run replay -- heldout` on the hosted Decider reproduced the published held-out numbers exactly: claim P 0.884 R 0.905 F1 0.894, routing P 0.806 R 0.806 (36 fired). Dev routing also matched (P 0.909 R 0.732). Per-line p50 ~500 ms from Colombo.
- **Gate** now uses the research gate questions (`self_repaired` + Platt-scaled `finished`), not the "would I interrupt?" question exp 7 found useless (AUC 0.57).
- **Hosted API limits found:** 3 concurrent requests -> 429; > 8 questions -> 422; ~30 s cold start. Provider queues and splits; demo warms up.
- **Bedrock:** `nvidia.nemotron-nano-3-30b` via the Bedrock API key in `.env`. Tool use and structured output work through Strands. Writing a line takes ~2-3 s, so the demo has the humans pause when the gate opens.
- **Demo (`npm run demo`):** dashboard + real-time call with Polly voices; transcript or Transcribe mode; template or Bedrock writer. On the checkout call Egg Head speaks once (false orders-DB claim, in the gap), stays silent when Mei corrects the deploy claim, when auth is parked, and on true claims. Bedrock: 2 calls for 12 lines (1 write, 1 escalation).
- **Transcribe mode** works but shows real ASR errors ("Auth" heard as "Office"); those lines escalate. Transcript mode is the reliable one for recording; show Transcribe as a short segment.
- **Spend so far** (scripts/aws-usage.sh, worst case ignoring free tier): Bedrock $0.0003, Polly $0.014, Transcribe $0.020.
- **Open:** record the video; write the article; held-out gate snippets still unscored; "park that" quiets every open claim (kept for parity).

## 0. Runtime migrated to TypeScript + Effect 4 (Thu 22 Oct)

The runtime (`egghead/`, `tests/`) is now TypeScript on Effect 4.0.5 in `src/` and `test/`; Python stays for `spike/` and `research/`. See AGENTS.md for layout and commands.

- Decider is an Effect `DecisionModel` provider (`src/Decider.ts`), Bedrock goes through the Strands TS SDK (`@strands-agents/sdk` 1.22, which has `InterventionHandler` and `deny` on `beforeModelCall`, same semantics as Python).
- Parity with the Python runtime is tested from golden fixtures: gate (pass-2 snippets reproduce REPORT-gate.md; 20,160-point input grid), exact question wording and option order, ten Bridge traces. 48 tests; a mutation check confirmed they fail on a threshold, wording or clock change.
- `egghead/gate.py` lives on as `spike/egghead_gate.py` (frozen) because `spike/gate_eval.py` and `research/decider/scripts/{final_eval,exp10_prompting}.py` import it.
- **Hosted API change:** `api.decider.cloud` now answers 422 unless the body has `"model": "strands-decider-2b"`. The old Python runtime client and `spike/run.py` did not send it; the TS provider and `spike/run.py` now do.
- **Live smoke (`npm run smoke`), hosted Decider:** the pipeline runs end to end (550–830 ms per batch from a laptop), but on a 5-line call nothing routes: "The orders DB is fine" got `which_check` 0.50 against T_ROUTE 0.7. Same request bytes as the Python runtime, so this is the known low routing recall (19% on pass 2), not a port bug. Next: apply the research findings to the runtime (latest-line kv state for routing, code-first resource lookup, yes/no per check, Platt calibration from `research/decider/results/exp6_platt_dev.json`).
- Kept as-is for parity, worth deciding: a "park that" anywhere after a claim lowers the cost of *every* open claim (`costLevel` scans all later turns), so unrelated claims go quiet too.

Previous status line: Sat 17 Oct 2026. The plan is in [PROJECT.md](PROJECT.md). Deadline: **Sat 24 Oct, 12:29 PM Colombo**.

## 1. Decide the open questions (from PROJECT.md)

- [ ] Hackathon tag: `#policy` (recommended) or `#tool-selection`
- [x] Name: **Egg Head**
- [x] Demo stack: **local only**, mocked check source with fault injection (`MockSource` in `src/Checks.ts`). The deliverable is a video, so nothing is hosted. Bedrock is still the writer/escalation path.
- [ ] Bedrock model and AWS region
- [ ] Voices for the scripted call: friends or TTS

## 2. Make a real cloud run possible

- [x] Create a GitHub repo (keep it **private** until submission, since originality requires it to be unpublished) and push `main`.
- [x] Start a cloud session on that repo.
- [x] Hardware: 4 vCPU x86_64, 15 GB RAM, **no GPU**. Hugging Face is reachable in the current cloud agent environment (earlier session had it blocked). Accuracy is valid; **re-measure latency on the M4** before quoting ms numbers. Pass-2 CPU batch p50 was ~12 s (8 questions).

## 3. Go/no-go test (done)

Harness: [spike/README.md](spike/README.md). Labels in `spike/dataset.jsonl` were written before any model run.

- [x] Install `strands-decider`, load `StrandsAgents/strands-decider-2B-qwen3.5-v1-2610`
- [x] Labelled dataset, batched `run.py`, `eval.py`, rewording on pass 1
- [x] Pass 1 on the real model → [spike/REPORT-pass1.md](spike/REPORT-pass1.md) (suggested **NO-GO** at T_ROUTE=0.9: routing fired 0/46; noul never reached conf ≥ 0.9)
- [x] Pass 2: simpler wording, LATEST-only routing, inverted `floor_free`, noul `silence_cost`, T_ROUTE=0.7 → [spike/REPORT.md](spike/REPORT.md)
- [x] **Verdict: GO-with-changes**

### What we keep

| Decision | Owner | Threshold / wording |
|---|---|---|
| Run a check | Decider `is_claim` + `which_check` + `which_resource` | Fire at **0.7**. Precision on pass 2: **100%** (4/4), recall 19%. Escalate the 0.55–0.7 band to Bedrock (counted). |
| Floor / interrupt | Decider `floor_free` asked as *"Would speaking interrupt?"* then invert | 87% accuracy. OR VAD silence ≥ 1.2 s (code). |
| Open question | Decider `open_question` | 87%. Useful for the dashboard; not required to speak. |
| Claim vs check | **Code** `compare()` | Do not wait for `asserted_state` when it says `unclear` (pass 2 dropped to 56%). If check+resource fired, run the check and compare. |

### What we move into code (Decider is weak here)

- **`silence_cost`**: 12% as noul; always ~0.4. Derive from check severity + whether the topic was parked (s07).
- **`self_repaired`**: 69%, overlap too high to threshold. Overlay keywords ("wait", "are you sure", "hold on") and ledger updates from later true claims.
- **Conf ≥ 0.9 rule**: empty coverage on every noul. Do not use it as the speak/check gate.

Pass-1 rewording that we adopted: interrupt wording for `floor_free`; "latest utterance only" for routing (stopped ledger leak into `which_check` on speak snippets).

## 3b. Speak gate rework (Mon 19 Oct)

The gate (then `egghead/gate.py`, now `src/Gate.ts`; frozen Python copy `spike/egghead_gate.py`) moves the weak Decider questions into code, per the pass-2 findings: `silence_cost` from the check that disagreed (and dropped when the call parks the topic), `self_repaired` from keywords / a later true claim with the Decider as a weak vote, and a hard 0.5 s minimum of silence before speaking. Re-scored on the saved pass-2 answers: [spike/REPORT-gate.md](spike/REPORT-gate.md) (`python spike/gate_eval.py`), precision/recall 0% / 0% → 100% / 100%.

**Caveat:** the rules were written after reading those 16 snippets, so this is a fit, not a held-out result. Needs ~15 new labelled gate snippets and a model run before the number is quoted.

Also written (Python, since ported to `src/`): `egghead/` (checks + `MockSource`, router, ledger, text-mode `Bridge`, Decider backends, template speaker) and `tests/` (`python -m unittest discover -s tests -t .`). Bedrock (`egghead/bedrock.py`): a Strands agent that is (a) the tool-calling writer when the gate opens (checks are its tools) and (b) the support for the 0.55-0.7 routing band (`Bridge(escalator=...)`, counted). `SpeakGuard` is the `InterventionHandler`. **The `Deny` TODO is resolved:** in `before_model_call` it sets `event.cancel`, the event loop skips the model and returns "DENIED: reason" with zero usage. Tested with stubs only; not yet run against real Bedrock (no credentials in the cloud session). Needs `EGGHEAD_MODEL_ID` / `AWS_REGION`.

**Held-out set:** `spike/dataset_heldout.jsonl` (20 snippets, labels committed before any run). Scoring is blocked: the cloud session's network policy denies `huggingface.co` (403), so the model could not be downloaded. Allow the host (or run on the M4), then run the two commands in the commit message / `spike/README.md`.

Not yet: audio, dashboard, a runnable demo script.

## 4. Build (GO-with-changes)

| When | Work |
|---|---|
| Sat 18 Oct | Check registry + small AWS demo stack + fault injection. `ClaimCheckRouter` end-to-end on text (T_ROUTE=0.7, Bedrock escalate mid-band). |
| Sun 19 Oct | `SpeakGate` in code (VAD + inverted `floor_free` + keyword self-repair + cost from the check) + claim ledger + Strands `InterventionHandler` + Bedrock. **First:** check what `Deny` does in `before_model_call`. |
| Mon 20 Oct | Audio: Transcribe streaming + Polly. Decision dashboard. |
| Tue 21 Oct | Scripted scenarios, "Bedrock on every utterance" baseline, metrics. Package both patterns with usage notes. |
| Wed 22 Oct | Builder Center article draft. Record demo. |
| Thu 23 Oct | Edit video (< 3 min), polish README, re-measure latency on the M4. |
| Fri 24 Oct AM | Buffer. Make repo public, publish article and video, submit before 12:29 PM Colombo. |

If time runs short, cut audio first. The text-mode pipeline plus dashboard still demonstrates the decision.

## 5. Submission checklist

- [ ] Agent uses Decider 2B for a meaningful decision, paired with Bedrock
- [ ] Public repo with source + reusable patterns (`ClaimCheckRouter`, `SpeakGate`: typed questions, option sets, `InterventionHandler` wiring, usage notes)
- [ ] Builder Center article: the agent, what it does, the decision handed to Decider, measured gains
- [ ] Public demo video under 3 minutes
- [ ] Tags: `#strands-decider-2b` + chosen pattern tag
- [ ] Original, not published before submission
