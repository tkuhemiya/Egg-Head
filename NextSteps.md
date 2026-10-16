# Next Steps

Status as of Fri 17 Oct 2026. The plan is in [PROJECT.md](PROJECT.md). Deadline: **Sat 24 Oct, 12:29 PM Colombo**.

## 1. Decide the open questions (from PROJECT.md)

- [ ] Hackathon tag: `#policy` (recommended) or `#tool-selection`
- [x] Name: **Egg Head**
- [ ] Demo stack: real AWS resources with fault injection (recommended) or mocked metrics
- [ ] Bedrock model and AWS region
- [ ] Voices for the scripted call: friends or TTS

## 2. Make a real cloud run possible

- [ ] Create a GitHub repo (keep it **private** until submission, since originality requires it to be unpublished) and push `main`:
  ```bash
  gh repo create Strands-Decider-usecase --private --source . --push
  ```
- [ ] Start a cloud session at **claude.ai/code** on that repo.
- [ ] Before relying on latency numbers, check what hardware the cloud session has (GPU or CPU only). Accuracy results are valid either way; latency must be re-measured on the M4.

## 3. Run the go/no-go test (day 1, today)

In the cloud session, or locally if the Mac is free. The goal is to find out whether Decider 2B answers our questions reliably before building anything.

- [ ] Install `strands-decider`, load `StrandsAgents/strands-decider-2B-qwen3.5-v1-2610`
- [ ] Write `spike/dataset.jsonl`: ~40 labelled bridge-call snippets. Write the correct answers **before** running the model. Include a mix of:
  - true and false claims
  - guesses that aren't claims
  - self-corrections
  - unanswered questions
  - mid-argument moments
  - unclear resource names
  - some deliberately tricky cases
- [ ] `spike/run.py`: all §5 questions in **one batch per snippet**. Confirm the state is read once.
- [ ] `spike/eval.py` → `spike/REPORT.md`:
  - per-question accuracy
  - accuracy and coverage at confidence ≥ 0.9
  - calibration table
  - speak-gate precision and recall
  - latency p50/p95 and hardware
  - rewording tests on the 2–3 worst questions
- [ ] **Verdict:** GO / GO-with-changes / NO-GO. Set thresholds and question wording.

If it's NO-GO: use fewer and simpler questions, move more structure into code, or narrow the claim types, then re-run.

## 4. Build (only after GO)

| When | Work |
|---|---|
| Sat 18 Oct | Check registry + small AWS demo stack + fault injection. `ClaimCheckRouter` end-to-end on text. |
| Sun 19 Oct | `SpeakGate` + claim ledger + Strands agent with `InterventionHandler` + Bedrock. Text-only end-to-end. **First:** check what `Deny` does in `before_model_call`. |
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
