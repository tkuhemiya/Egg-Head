# Next Steps

Status as of Sat 17 Oct 2026. The plan is in [PROJECT.md](PROJECT.md). Deadline: **Sat 24 Oct, 12:29 PM Colombo**.

## 1. Decide the open questions (from PROJECT.md)

- [ ] Hackathon tag: `#policy` (recommended) or `#tool-selection`
- [x] Name: **Egg Head**
- [ ] Demo stack: real AWS resources with fault injection (recommended) or mocked metrics
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
