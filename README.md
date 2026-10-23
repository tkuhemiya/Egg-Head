# Egg Head

A decision layer for voice agents. It decides when a model should speak, and when it should stay quiet, by sorting what people say, checking claims against a source of truth, and speaking up only when it matters. The demo runs it on a scripted incident call, but the incident is only the scenario. Strands Decider 2B makes the "should I say something?" calls in a few hundred milliseconds. Amazon Bedrock runs only when Egg Head actually has to investigate or talk.

Built for the **Agent Experience Hackathon: Strands Decider**.

# Getting started

You need Node ≥ 22. Nothing below needs Python.

**1. Install and run the tests (no network)**

```bash
npm install
npm test          # vitest: the reducer, router, gate, parity fixtures, every call scenario
npm run check     # tsc --noEmit
```

**2. Watch the demo offline**

```bash
npm run demo -- --rehearsal
```

Open http://localhost:8787 and press **Start**. That page is the meeting: five cartoon teammates lip-sync to their lines, Egg Head has its own tile, and the coding agent's terminal grows on the side while it works. http://localhost:8787/dashboard is the run dashboard: a decision tree of every way a line can go, with Decider's scores against each threshold. Rehearsal makes no network calls. The Decider and agent answers are scripted and the voices are silent.

**3. Run it live**

Put the Bedrock settings in `.env` (gitignored; `npm run demo` loads it):

```bash
AWS_REGION=us-east-1
AWS_BEARER_TOKEN_BEDROCK=...                 # a Bedrock API key, or use the normal AWS credential chain
EGGHEAD_MODEL_ID=nvidia.nemotron-nano-3-30b
EGGHEAD_VOICE_REGION=ap-south-1              # Polly/Transcribe region nearest you
```

Polly and Transcribe use the default AWS credential chain (`aws login` works). A Bedrock API key does not cover them. Then:

```bash
npm run demo                                 # hosted Decider + pi on Bedrock + Polly voices
npx tsx scripts/check-run.ts latest          # score the run you just did, line by line
```

A live run costs about $0.01 of Polly the first time (clips are cached in `demo/out/audio/`, so re-runs are free), about $0.02 of Transcribe in transcribe mode, and under $0.001 of Bedrock. `scripts/aws-usage.sh` prints today's spend.

### Demo flags

`npm run demo -- <flags>`

| Flag | Default | What it does |
|---|---|---|
| `--rehearsal` | off | No network at all: scripted Decider and agent model, silent voices with estimated lip-sync marks |
| `--agent <pi\|none>` | `pi` | `pi` runs the pi coding agent on Bedrock in a real terminal for second looks. `none` makes Egg Head speak from the fast checks alone |
| `--agent-cmd "<cmd>"` | | Use any other terminal coding agent instead of pi (for example `"claude"`). It gets the same PATH, prompts and `egghead report` command |
| `--agent-env A,B` | | Environment variables to pass through to `--agent-cmd`. It sees only the ones you name |
| `--agent-model <id>` | `EGGHEAD_AGENT_MODEL`, else `EGGHEAD_MODEL_ID` | pi's Bedrock model, for example `qwen.qwen3-coder-30b-a3b-v1:0` |
| `--agent-timeout <s>` | `60` | After this long, a second look falls back to the direct check |
| `--writer <template\|bedrock>` | `template` | `bedrock` also sends claims the router could not place to Bedrock (escalations) |
| `--mode <text\|transcribe>` | `text` | `transcribe` streams the call audio through Amazon Transcribe, and the transcripts are what Egg Head hears |
| `--call <file>` | `data/calls/checkout-incident.json` | Which call script to play (there are eight in `data/calls/`) |
| `--port <n>` / `--host <addr>` | `8787` / `127.0.0.1` | Where to serve. `--host 0.0.0.0` serves other machines |
| `--autostart` | off | Start the call without pressing Start |

Page options: `/dashboard?replay` shows the last run. The meeting page has no camera or microphone; it shows the teammates, Egg Head and the feed.

### Environment

| Variable | Meaning |
|---|---|
| `EGGHEAD_DECIDER_BACKEND` | `public` (default: the free hosted Decider at `api.decider.cloud`) or `http` (your own `strands-decider serve`) |
| `EGGHEAD_DECIDER_URL` / `EGGHEAD_DECIDER_MODEL` | Base URL and model id when the backend is `http` |
| `EGGHEAD_MODEL_ID`, `AWS_REGION`, `AWS_BEARER_TOKEN_BEDROCK` | Bedrock (the writer and pi) |
| `EGGHEAD_AGENT_MODEL` | pi's model, if it differs from `EGGHEAD_MODEL_ID` |
| `EGGHEAD_VOICE_REGION` | Region for Polly and Transcribe (falls back to `AWS_REGION`) |

### Other scripts

```bash
npm run smoke                  # live: a short scripted call through the Bridge with the hosted Decider
npm run replay -- heldout      # live: the router over the research dataset; must reproduce the research numbers
npx tsx scripts/probe-bedrock.ts                                        # two live Bedrock calls
npx tsx scripts/record-demo.ts --out demo/out/egghead-demo.mp4          # film the meeting page to an mp4 (needs ffmpeg)
spec/check.sh                  # model-check the TLA+ spec of when Egg Head speaks (needs Java)
npx tsx scripts/diagrams.ts    # re-render the diagrams in this README
```

# How it works

### The problem nobody had solved

Voice agents only know how to *answer*. LiveKit, Pipecat, Deepgram Flux and AssemblyAI all ship trained end-of-turn models for one question: "has the user finished talking **to me**?" On a bridge call the humans are talking **to each other**, so the question becomes "should I say something at all?" That is a much harder question, and the research agrees: in *Speak or Stay Silent* ([arXiv 2603.11409](https://arxiv.org/abs/2603.11409)) eight LLMs "consistently fail" at it zero-shot. *Jarvis* ([arXiv 2610.07506](https://arxiv.org/html/2610.07506)) gets it right, but it needs a 35B MoE monitor to do it.

Egg Head does it with a **2B decision model** and no training. The trick is never to ask it the hard question. It gets lots of small, easy yes/no questions, and plain code handles everything that can be done deterministically.

### What happens to one line

![What happens to one line of the call](docs/diagrams/line.svg)

1. **Is it a claim?** Decider gets the latest line only and answers four narrow yes/no questions in one batch ("says how something is right now, as fact", "reports a status or number", the inverted "hedging, asking or planning", and a short catch-all). A small logistic regression fit on our dev set combines them, and Platt scaling calibrates the result.
2. **About what?** Code finds the resource by alias (`orders db` → `orders-db`). Then Decider picks *that resource's* check from a short list, asked over every option order and averaged.
3. **Is it true?** Code runs the check and compares. If it agrees, Egg Head stays quiet, and this is the path most lines take. No LLM call happens.
4. **Does it stick?** A contradicted claim goes on the ledger. If the call corrects it within one turn, it closes with no model call at all.
5. **Second look.** If it survives a turn, the claim goes to a real coding agent (pi on Bedrock, in a real terminal). The agent runs `aws` commands and reports back with `egghead report`.
6. **Speak gate.** Code combines Decider's "did they self-repair?" and "is the turn finished?" with silence, cost level and cooldown. If the gate opens, Egg Head says one grounded sentence (a template, or Bedrock), and Polly voices it.

Lines that aren't claims take a different branch. If someone is talking *to* Egg Head, it waits until they've finished and then answers. If a question is left hanging for 2.5 s, Egg Head takes it. And if someone is about to act on a wrong claim ("Jordan, restart the payments API now"), Egg Head **barges in** on the live partial transcript, before the sentence has even finished.

### The life of a claim

Each claim on the ledger is a small state machine. It is pure data, and only the reducer can move it:

![The life of a claim](docs/diagrams/claim.svg)

Without an agent (`--agent none`), a contradicted claim goes straight to `Standing` and the gate decides alone.

### The floor

Egg Head's own voice is an input too. The **Floor** tracks whether it is quiet, writing, or talking, so it can't talk over itself or stack two lines into one gap:

![Who has the floor](docs/diagrams/floor.svg)

Egg Head gets one line per gap: it can speak again only after a human has taken a turn, or after 3 s of quiet. A barge-in may cut off a human, but it never starts while Egg Head is `Composing` or `Speaking`.

### The tech decisions we're proudest of

**A 2B model asked easy questions beats a big model asked a hard one, at least for timing.** A 120B reasoning LLM is more accurate per line (more on that below), but its median is 1.2 s and its p95 is 3 s. Turn-taking happens within about half a second. Decider answers a batch of eight questions in around 90 ms server-side, and batching is effectively free: asking one question or eight moved answers by 0.002 on average. So every line gets all its questions at once.

**Yes/no questions, never multiple choice.** This was the biggest single finding of the research campaign. A three-way "request, claim or other?" got macro-F1 0.70. The same split asked as two yes/no questions in one batch got **0.93**. When a choice can't be avoided, we ask it in every option order and average, because the top answer flipped on 22–33% of items when we rotated the options.

**Code first, model second.** Code resolves the resource by alias and Decider only picks among that resource's checks. Routing F1 went from 0.55 (one big check×resource choice) to 0.74. Wherever a keyword exists (the agent's name, "hold on", a trailing "and"), a rule matches or beats the model, so a rule does that job.

**Calibrate, then threshold.** Decider's raw probabilities rank well but sit in a narrow 0.2–0.8 band. "Is the turn finished?" scored **F1 0.00** at a raw 0.5 and **0.96** after Platt scaling. Every threshold in Egg Head is applied to a calibrated number.

**Let the humans fix it first.** Following Jarvis, Egg Head never jumps on a claim straight away. In the research, waiting for a claim to go uncorrected took false interrupts on our correction sequences from 9 of 12 (reacting at once) to 3 of 12 after two turns and 0 after three. Egg Head waits one turn, then also needs the agent to confirm it and the gate to open. The bonus: a claim the call corrects itself costs no model call at all.

**Silence never reaches the model.** A Strands `InterventionHandler` (`SpeakGuard`) denies Bedrock's `beforeModelCall` while the gate is closed. The rule "only speak when the gate is open" is enforced by the framework, not by a polite system prompt. We test it against a real Strands agent.

**One pure reducer owns all state.** Every input (a heard line, a partial transcript, a finished job, Egg Head's own speech ending) goes through `Step.reduce`: pure, total, in one `Ref.modify`. Slow work (Decider, checks) runs against a snapshot *before* the lock. Side effects (start the agent, write a line) run *after* the commit. So an agent job can never start for a state that didn't happen. It's TypeScript on Effect 4, with `Schema` on every untrusted input.

**When Egg Head speaks is formally specified.** `spec/Bridge.tla` is a TLA+ model of the Bridge, and TLC checks every rule. `test/SpecSync.test.ts` fails if a state or action name in the spec drifts from the code.

**The agent is a real coding agent in a real terminal.** Second looks don't come from a bespoke tool-calling loop. We run pi (or Claude Code, or any CLI agent, with `--agent-cmd`) in a node-pty terminal and give it a stand-in `aws` CLI that answers from `data/aws.json` in real CLI shapes. Point it at a real account and nothing else has to change. What the call says reaches the agent as quoted, control-character-stripped data, so a transcript can't press Enter in its prompt.

### Where the code lives

| Path | What it is |
|---|---|
| `src/domain/` | The pure core: `Step.reduce`, `Claims`, `Requests`, `Jobs`, `Floor`, `Agenda`, `Gate`, `Router`, `Questions`. No I/O |
| `src/runtime/` | Effect services: `Bridge`, `Decider`, `Investigator`, `Bedrock` (`SpeakGuard`), `Call`, `Judge` |
| `demo/` | The meeting page and dashboard, the call runner, Polly voices and Transcribe streaming, the terminal agent |
| `data/` | The mock world (`world.json`, `aws.json`) and the eight call scripts in `data/calls/` |
| `spec/` | The TLA+ model and `check.sh` |
| `docs/research/decider/` | The Decider research campaign: data, scripts, results, [`FINDINGS.md`](docs/research/decider/FINDINGS.md) |

[`AGENTS.md`](AGENTS.md) covers the glossary, the Effect conventions and the Decider HTTP details.

# Receipts: why we think this could really work

Hackathon demos are easy to fake. Here is everything we did to convince ourselves this isn't one, including the parts that didn't go well.

### 1. A preregistered research campaign

Before writing the agent, we ran eleven experiments on Decider ([`FINDINGS.md`](docs/research/decider/FINDINGS.md)). We wrote 273 incident-call lines and split them 138 dev / 135 held-out. We froze the data with sha256 hashes before any model saw it. We tuned only on dev, wrote our choices into `PREREGISTERED_*.json`, and then scored held-out **once**.

| Held-out task | Decider pipeline | Rule baseline | Nemotron 3 Super 120B |
|---|---|---|---|
| Is it a claim? | F1 **0.89** (P 0.88 R 0.90) | keyword regex F1 0.64 | F1 0.98 |
| Claim → right check and resource | F1 **0.81** (P 0.81 R 0.81) | keyword route F1 0.72 | F1 0.95 |
| Speak gate (18 cases) | F1 **0.83**, 3 false interrupts | silence ≥ 1.5 s: F1 0.78 | F1 0.88, 3 false interrupts |
| Latency per line | p50 ~90 ms server-side | — | p50 1.2 s, p95 3.0 s (no reasoning) |

Our honest read: Decider clearly beats rules on claim detection and the speak gate. A 120B LLM is more accurate on every task, by 5–14 F1 points. It is also about 13× slower at the median, it costs per token, and at p95 it misses the turn-taking window entirely. Decider's case is latency, cost and calibrated confidence, not raw accuracy. The obvious next step is a cascade: Decider on every line, and the LLM only on the few lines Decider flags.

We also reported what didn't work: definitions in the question (−6 AUC points), examples in the prompt, personas and contextual calibration all did nothing or hurt this 2B model.

### 2. The TypeScript port reproduces the research exactly

The router and gate were first written in Python for the research and then ported to TypeScript. `npm run replay -- heldout` runs the TypeScript router over the held-out set against the live hosted Decider. On 22 Oct it reproduced experiment 9 to the third decimal: claim P 0.884 R 0.905, route P 0.806 R 0.806. `test/Parity.test.ts` holds the port to the Python without any network: the 16 gate snippets, a 20,000-point grid of gate inputs, and ten full Bridge traces. `test/Questions.test.ts` pins every question's wording and every combiner to the Python.

### 3. A model checker, not just tests

`spec/check.sh` runs TLC on `spec/Bridge.tla`. It checks seven safety rules: Egg Head never speaks firmly on an unconfirmed claim, never tells the call something it already corrected, never calls a right claim wrong, never barges tentatively without a check running, never lets parking one resource mute another, and never stacks two lines in one gap. It also checks two liveness rules: every "On it" gets answered, and every confirmed claim gets resolved. The `TypeOK` run explores 81,559 distinct states. Five of these rules failed against the first Bridge, and that is why we rebuilt it as gather / reduce / interpret (see [`docs/design/bridge-rework/`](docs/design/bridge-rework/README.md)).

### 4. Every scenario is judged line by line, and the judge is tested too

Each of the eight call scripts in `data/calls/` says, for every line, what Egg Head should do ("quiet", "barge to Priya about payments-api", "ack 0.5 s to 1 s after the line"). `test/Scenarios.test.ts` plays every script through the real call loop and Bridge in virtual time and judges it, checking four invariants as well. A new script is a new test.

To prove those scenarios can fail, `test/Mutants.test.ts` builds ten deliberately broken Bridges (one wrong threshold each: never barges, speaks over a live voice, no cooldown, and so on). Some line in some scenario must catch every one of them. A surviving mutant means a behaviour nobody pinned down.

All told, that's 115 tests in 15 files, with no network and no AWS. They include prompt-injection tests for the terminal agent and a test that `SpeakGuard` stops a real Strands agent.

### 5. Live runs, scored the same way

Every demo run is saved to `demo/out/runs/` and scored with the same judge (`npx tsx scripts/check-run.ts`). Our one complete live run (hosted Decider, pi on Bedrock Nemotron Nano 3, Polly) scored **12 of 18 lines, with all 4 invariants held**: it never talked over anyone, always waited for silence, and never broke the cooldown or the line budget.

The misses are instructive. Five of the six failing lines are one timing slip: Egg Head said the right things ("On it, Priya", then the queue depth, then the payments-api deploy), but each one arrived about a line late, so the judge saw it on the wrong line. The sixth is the barge-in, which didn't fire.

Digging into it turned up a real bug. The agent's job queue (`demo/Agent.ts`) drained its wake-ups with Effect's `Queue.takeAll`, which *waits* when the queue is empty. So every job sat unsent until the next job arrived. In that run Sam's claim never got its second look, and each answer went out one job late through the direct-check fallback. We fixed it on 24 Oct, along with an accidental downgrade of pi that broke the scripted rehearsal model. Now a rehearsal scores 18 of 18 with pi answering every job itself in about 3 s. The live run needs repeating after the fix. Separately, the hosted Decider took a median of 1.4 s per line end to end from Colombo in that run (several batches through one queue), against ~90 ms server-side in the research. A nearer Decider or a local `strands-decider serve` is the next latency fix.

### What isn't proven yet

- We labelled the research data ourselves, and it is small (n ≈ 45 positives per task). Treat a gap of a few points as noise.
- Three newer questions ("spoken to?", "left hanging?", "telling someone to act now?") have no held-out numbers yet. Their thresholds are hand-set.
- There is no live microphone yet. In transcribe mode, Amazon Transcribe hears Polly reading the script, not real people, and the speaker comes from the script rather than diarization. The Bridge only consumes text, so a meeting platform's per-speaker transcript would plug straight in.
- The demo world is mocked (`data/aws.json`). The checks and the agent's `aws` calls have the real shapes, but they haven't been pointed at a real account.
