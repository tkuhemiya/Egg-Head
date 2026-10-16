# Egg Head — the on-call agent that knows when to speak

> A voice agent that sits silently on an incident bridge call, checks what people claim against the real systems, and speaks up only when it matters. Strands Decider 2B makes the "should I check / should I speak" calls locally in ~150 ms. Amazon Bedrock only runs when the agent has something worth saying.

- **Hackathon:** Agent Experience Hackathon: Strands Decider
- **Due:** Sat 24 Oct 2026, 12:29 PM Colombo
- **Gates:** Gate 1 (AI + human, top 100) week of 26 Oct · Gate 2 (human panel) week of 2 Nov · Winners week of 9 Nov
- **Tags:** `#strands-decider-2b` + one pattern tag (see [Open questions](#open-questions))

---

## 1. What the judges want, and how we meet it

The brief asks for *"a working agent on AWS that does something cool, using Strands Decider 2B to make a meaningful decision."* They want an agent, not a full product. Build just enough agent to make people care, and make the decision visible.

| Rubric | Weight | How we score |
|---|---|---|
| Creativity / cool factor | 30% | An AI teammate that stays quiet 95%+ of the time and is right when it speaks. The demo is a live incident call where it catches a false "the DB is fine". |
| Effective use of Decider | 30% | Several Decider questions per utterance against one cached state. It also picks which check to run and when to speak. Calibrated confidence feeds plain `if` statements. Measured Bedrock calls, cost and latency avoided. |
| Communication | 25% | Before/after video, live decision dashboard in the video, and an article on "how to make an agent shut up". |
| Originality | 15% | Basic end-of-turn detection is solved, but "when should an agent speak to a group" is not. Prior research needs a 35B model or fine-tuning. We use a 2B model on a laptop with no training. |

---

## 2. The problem

**Voice agents only know how to answer.** Every voice framework (LiveKit, Pipecat, Deepgram Flux, AssemblyAI) solves *"has the user finished talking to me?"* with trained end-of-turn models. None of them answer *"the humans are talking to each other — should I say something?"*

**Meeting tools are passive.** Notetakers (Otter, Fireflies, Granola, Zoom AI Companion) summarise after the fact. The Augmented AI (May 2026) shows insights as text to one user, but does not speak to the group.

**Research says it's hard.**
- *Speak or Stay Silent* (arXiv 2603.11409): eight LLMs "consistently fail" at speak-or-stay-silent zero-shot. Only fine-tuning helped (+23 pts balanced accuracy).
- *Jarvis* (arXiv 2610.07506, Oct 2026): a proactive speech agent for paper discussions. It uses a 35B MoE monitor (3B active) over six categories, a self-repair check and a deterministic gate with a claim ledger. It stays silent 97% of the time when people self-correct and is 95–97% correct when it speaks. Research only.
- Also: Inner Thoughts (2501.00383), When2Speak (2605.05626), ProMediate (Microsoft), ModeratorLM (2606.13544).

**Our take:** Jarvis confirms the design (classifier → check → deterministic gate → generator). We differ in three ways:
1. **Setting:** a live operational incident, not a paper discussion.
2. **Ground truth from real systems:** claims are *checked against live infrastructure*, not against a document.
3. **Model size:** the monitor is a 2B decision model, split into easy sub-questions, with no training.

---

## 3. Core idea: listen → decide → check → decide → speak

On an incident call, people constantly make claims about system state, for example:

> "The DB is fine, it's the API." · "We didn't deploy anything today." · "Error rate is back to normal."

Some are wrong, and wrong claims send the team chasing the wrong thing. Egg Head:

1. **Hears** each utterance (speaker-labelled transcript).
2. **Decides** whether the utterance is a *checkable claim*, and if so **which check** to run and **on which resource**. This is a Decider choice over a registry of checks and a live resource inventory.
3. **Runs the check deterministically** (CloudWatch metrics, alarm state, health endpoint, deploy history) and compares the result with the claim *in code*.
4. **Decides whether to speak:**
   - Is there a real contradiction or an unanswered question?
   - Has someone already corrected it?
   - Is there a natural gap in the conversation?
   - How costly is staying silent?
5. **Speaks** only if the gate passes. A Strands agent on Bedrock writes one short, evidence-backed sentence, and Polly speaks it, e.g. *"Quick flag — orders-db CPU has been at 98% for the last 6 minutes, alarm's in ALARM."* The evidence also appears on screen.

Decider makes the judgment calls. Code does everything deterministic. Bedrock writes text, and only when it's needed.

---

## 4. Architecture

```
 mic / call audio
      │
      ▼
 Amazon Transcribe streaming (speaker labels)
      │  final segments
      ▼
 ┌───────────────────────────── Egg Head (local) ─────────────────────────────┐
 │                                                                            │
 │  Transcript window + Claim ledger  (code: rolling window ≤ ~3k tokens)     │
 │      │                                                                     │
 │      ▼                                                                     │
 │  Decider 2B  — one cached state, many questions (~150–250 ms on M-series)  │
 │      │  probabilities                                                      │
 │      ▼                                                                     │
 │  Check router (code) ──► Check registry ──► AWS APIs (CloudWatch, etc.)    │
 │      │  verdict: supports / contradicts / inconclusive                     │
 │      ▼                                                                     │
 │  Speak gate (code: thresholds, persistence, cooldown, silence timer)       │
 │      │  only when open                                                     │
 │      ▼                                                                     │
 │  Strands Agent ── InterventionHandler ── Amazon Bedrock (Claude)           │
 │      │  one grounded sentence + evidence                                   │
 └──────┼─────────────────────────────────────────────────────────────────────┘
        ▼
 Amazon Polly ──► call audio          Dashboard ◄── every decision + latency
```

**Who does what:**

| Concern | Owner | Why |
|---|---|---|
| Speech-to-text, speaker labels | Amazon Transcribe | Commodity |
| Silence length, VAD, cooldowns, rate limits | Code | Deterministic |
| Transcript window, claim ledger, dedupe | Code | Deterministic |
| "Is this a checkable claim? Which check? Which resource? What does the speaker assert?" | **Decider** | Judgment, fast, every utterance |
| Running the check and comparing with the claim | Code | Deterministic, auditable |
| "Already corrected? Natural gap? Unanswered question? Cost of silence?" | **Decider** | Judgment |
| Final speak/no-speak | Code over Decider probabilities | Predictable |
| Writing the sentence | Bedrock via Strands Agent | Decider can't generate text |
| Speaking it | Amazon Polly | Commodity |

---

## 5. Decision design (the Decider questions)

All questions run as **one batch per utterance** against one state, which keeps the cost low. The state is the recent transcript window, the latest utterance marked, and the open ledger items.

### 5.1 Claim routing (tool selection)

| id | type | question | options |
|---|---|---|---|
| `is_claim` | noul | Does the latest utterance assert something about the current state of a system, service, metric or recent change? | — |
| `which_check` | choice | Which check would verify the latest utterance? | registered checks + `none` (e.g. `db_health`, `service_error_rate`, `latency_p99`, `recent_deploys`, `alarm_state`, `queue_depth`, `none`) |
| `which_resource` | choice | Which resource is the latest utterance about? | **live inventory names**, built at runtime (e.g. `orders-db`, `payments-api`, `checkout-queue`, `unknown`) |
| `asserted_state` | choice | What does the speaker claim about it? | `healthy`, `degraded`, `down`, `changed`, `unchanged`, `unclear` |

Decider can't extract free text, but **options are open-ended at inference time** (up to 255). So "which DB?" becomes a choice over the real inventory, and new services need no retraining.

### 5.2 Speaking (policy)

| id | type | question | options |
|---|---|---|---|
| `self_repaired` | noul | Since the flagged claim, has anyone already corrected or questioned it? | — |
| `open_question` | noul | Is there a question in the recent conversation that nobody has answered? | — |
| `floor_free` | noul | Is this a natural moment to interject, rather than mid-thought or mid-argument? | — |
| `silence_cost` | score | How harmful would it be for the team to keep going without this information? | `none`, `low`, `moderate`, `high`, `critical` |

### 5.3 Gate (code)

```text
run check     if is_claim ≥ 0.9 and which_check ≠ none with confidence ≥ 0.9
              and which_resource ≠ unknown with confidence ≥ 0.9
contradiction = compare(asserted_state, check_result)        # pure code
speak         if contradiction persisted ≥ 1 turn
              and self_repaired < 0.3
              and (floor_free ≥ 0.7 or silence ≥ 1.2 s)      # silence from VAD/timestamps
              and E[silence_cost] ≥ moderate
              and cooldown elapsed
low confidence (0.6–0.9) on routing → escalate that one decision to Bedrock (counted, logged)
```

Choice confidence = `(N·p_max − 1)/(N − 1)`, so one threshold works regardless of how many checks or resources are registered.

The thresholds above are starting points. The spike (§10) calibrates them.

---

## 6. Checks (deterministic tools)

A **check** is a typed Python function plus a one-line description. The description is the Decider option label.

```python
@check("db_health", "Database health: CPU, connections, and alarm state for a database")
def db_health(resource: str) -> CheckResult:
    # CloudWatch GetMetricData + DescribeAlarms → status in {healthy, degraded, down}
    ...
```

Initial registry:

| Check | Source | Returns |
|---|---|---|
| `db_health` | CloudWatch (CPU, connections), alarms | healthy / degraded / down + evidence |
| `service_error_rate` | CloudWatch / ALB 5xx | healthy / degraded + numbers |
| `latency_p99` | CloudWatch | healthy / degraded + numbers |
| `recent_deploys` | Deploy log (CodeDeploy, or a demo deploy table) | changed / unchanged + what and when |
| `alarm_state` | CloudWatch DescribeAlarms | list of alarms in ALARM |
| `queue_depth` | SQS ApproximateNumberOfMessages | healthy / degraded |

Each check returns structured evidence `{status, metric, value, window, link}` so the spoken sentence and the dashboard cite real numbers.

---

## 7. Strands wiring (InterventionHandler)

The Strands agent receives every utterance. A `InterventionHandler` decides whether it ever reaches Bedrock:

- **`before_model_call`** → run the gate. If closed, return `Deny`. Silence never touches Bedrock.
- **`after_model_call`** → re-ask `self_repaired` and `floor_free` on the *latest* state. The conversation moved on while Bedrock was writing, so drop the reply if someone already said it.
- **`before_tool_call`** (optional) → reuse the claim-routing questions if the agent tries to run checks itself.

> TODO: check in the Strands source what `Deny` does in `before_model_call` (return value / exception / event flow) before building on it. Reference: `strands-labs/strands-decider/examples/strands/tool_call_intervention.py`.

---

## 8. Reusable decision patterns (deliverable)

1. **`ClaimCheckRouter`**: utterance → `is_claim` + `which_check` (choice over a check registry) + `which_resource` (choice over a live inventory) + `asserted_state`. Works anywhere an agent should check claims against tools: support chats, code review, ops chat.
2. **`SpeakGate`**: `self_repaired` + `open_question` + `floor_free` + `silence_cost`, plus a code gate, wired as an `InterventionHandler` that `Deny`s model calls. Works for any proactive agent: group chat, meetings, games.

Each ships with typed question definitions, option sets, the handler wiring, default thresholds and a usage note.

---

## 9. Demo and measurement

### Demo setup
- A small **demo stack on AWS**, e.g. API + DB + queue, emitting CloudWatch metrics, with a **fault-injection switch** (spike DB CPU, push a "deploy").
- **Scripted incident calls**, voiced by people or pre-recorded so runs are repeatable. Each script contains true claims, false claims, self-corrections and unanswered questions.
- **Dashboard:** live transcript, each Decider question with its probability and latency, check results, gate state, and the Bedrock call counter.

### Video (under 3 min)
1. **Hook (0:00–0:20):** "Every AI on a call either says nothing or never stops talking."
2. **The incident (0:20–1:40):**
   - People debug.
   - Someone says "DB is fine".
   - Egg Head checks, finds a contradiction, waits for a gap and gives a one-sentence flag with evidence.
   - Later a teammate corrects someone themselves, and Egg Head stays silent (shown on the dashboard).
3. **Side by side (1:40–2:20):** a "Bedrock on every utterance" baseline, showing cost, latency and noise.
4. **How it works and the patterns (2:20–2:55).**

### Metrics (baseline = LLM decides on every utterance)
- Bedrock calls / tokens / $ per call-hour, Bedrock-only vs Egg Head
- Decision latency per utterance (Decider p50/p95 vs Bedrock)
- Interjection precision and recall on labelled scripts; false interjections; correct silences after self-repair
- Calibration: accuracy of answers at confidence ≥ 0.9
- Escalation rate: share of decisions passed to Bedrock

---

## 10. Plan

| Day | Date | Work |
|---|---|---|
| 1 | Fri 17 Oct | **Go/no-go test.** Install Decider (`--device mps`/`mlx`). Hand-label ~40 snippets: claim or not, check, resource, asserted state, speak or not. Measure accuracy, calibration, latency. Adjust the question wording. |
| 2 | Sat 18 Oct | Check registry + demo AWS stack + fault injection. ClaimCheckRouter end-to-end on text. |
| 3 | Sun 19 Oct | SpeakGate + claim ledger + Strands agent with InterventionHandler + Bedrock. Text-only end-to-end. |
| 4 | Mon 20 Oct | Audio: Transcribe streaming + Polly. Dashboard. |
| 5 | Tue 21 Oct | Scripted scenarios, baseline, metrics. Package the patterns + usage notes. |
| 6 | Wed 22 Oct | Article draft (Builder Center). Record demo. |
| 7 | Thu 23 Oct | Edit video, polish repo README, final measurements. |
| 8 | Fri 24 Oct (AM) | Buffer, submit before 12:29 PM Colombo. |

If day 1 fails (routing is not reliable at high confidence), simplify: fewer and blunter questions, use more structure from code, or narrow the claim types. The text pipeline still works without audio, so audio is the first thing to cut if time runs short.

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| Decider unreliable on these questions (hard-task accuracy 0.505) | Keep each question *easy* and single-hop. Gate on confidence ≥ 0.9. Escalate the middle band to Bedrock. Validate on day 1. |
| 4,096-token context | Rolling window + compact ledger, handled in code |
| CPU latency (~1.6 s/question) | Run on Apple Silicon with MPS/MLX. Per-utterance timing tolerates a few hundred ms. |
| Transcribe speaker labels are noisy | Speaker identity isn't needed for most questions. Scripted demo keeps it clean. |
| Looks like a Jarvis reimplementation | Different setting, checks against live systems, 2B model with no training. Cite Jarvis openly in the article. |
| Audio pipeline eats the schedule | Text-mode demo first. Audio is a layer on top. |

---

## 12. Constraints we follow

- No post-training of Decider. Use only the published weights.
- Anything deterministic is done in code. Decider is used only for judgment.
- Don't look at the hackathon projects tab for ideas.
- Original and unpublished until submission.

---

## Open questions

1. **Declared pattern tag:** `#policy` (SpeakGate is the headline) or `#tool-selection` (ClaimCheckRouter)? Leaning `#policy`, with tool selection as the second pattern.
2. ~~**Name**~~ — decided: **Egg Head**.
3. **Demo stack:** real AWS resources with fault injection (more convincing) vs a mocked metrics source (cheaper, fully repeatable)? Leaning real AWS with a small footprint.
4. **Bedrock model and region** for generation and the escalation baseline.
5. **Voices for the scripted call:** friends, or TTS voices for the "humans"?

---

## Sources

- Hackathon: https://builder.aws.com/build/hackathons/4f50957c-1d08-37ab-b11c-97516b9adeb4/agent-experience-hackathon-strands-decider
- Strands Decider repo: https://github.com/strands-labs/strands-decider · inference docs: https://github.com/strands-labs/strands-decider/blob/main/docs/inference.md · Strands example: https://github.com/strands-labs/strands-decider/tree/main/examples/strands
- InterventionHandler API: https://strandsagents.com/docs/api/python/strands.interventions.handler/index.md
- Decider on Mac (latency/memory): https://dev.classmethod.jp/en/articles/strands-decider-local-setup/
- Jarvis: https://arxiv.org/html/2610.07506
- Speak or Stay Silent: https://arxiv.org/abs/2603.11409
- Inner Thoughts: https://arxiv.org/abs/2501.00383
- When2Speak: https://arxiv.org/pdf/2605.05626
- ProMediate: https://www.microsoft.com/en-us/research/articles/evaluating-proactive-ai-mediators-in-multi-party-conversation-with-promediate/
- ModeratorLM: https://tldr.takara.ai/p/2606.13544
- End-of-turn prior art: https://livekit.com/blog/solving-end-of-turn-detection · https://huggingface.co/soniqo/Smart-Turn-v3.2-ONNX · https://www.assemblyai.com/blog/turn-detection-endpointing-voice-agent · https://deepgram.com/learn/build-voice-agent-pipecat-deepgram-flux-stt-tts
- The Augmented AI: https://www.producthunt.com/products/the-augmented-ai-live-ai-cortex/launches/the-augmented-ai
