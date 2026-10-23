# Egg Head: the on-call agent that knows when to speak

A pattern for agents that decide, locally and fast, *when a person's turn is over, whether to speak up or stay silent, and what to do about what was just said*. Strands Decider 2B makes those calls in a few hundred milliseconds; Amazon Bedrock only runs when the agent acts. **The demo** is a voice agent on a scripted incident bridge call: it checks what people claim against the systems and speaks up only when it matters. The incident call is the showcase, not the goal.

Built for the **Agent Experience Hackathon: Strands Decider** (due Sat 24 Oct 2026, 12:29 PM Colombo).

## The problem

**Voice agents only know how to answer.** LiveKit, Pipecat, Deepgram Flux and AssemblyAI solve *"has the user finished talking to me?"* with trained end-of-turn models. None of them answer *"the humans are talking to each other: should I say something?"*

**Meeting tools are passive.** Notetakers (Otter, Fireflies, Granola, Zoom AI Companion) summarise after the fact. The Augmented AI (May 2026) shows insights as text to one user, but does not speak to the group.

**Research says it is hard.** *Speak or Stay Silent* ([arXiv 2603.11409](https://arxiv.org/abs/2603.11409)): eight LLMs "consistently fail" zero-shot; only fine-tuning helped. *Jarvis* ([arXiv 2610.07506](https://arxiv.org/html/2610.07506)) gets it right with a 35B MoE monitor, a self-repair check and a deterministic gate over a claim ledger. Also: Inner Thoughts ([2501.00383](https://arxiv.org/abs/2501.00383)), When2Speak ([2605.05626](https://arxiv.org/pdf/2605.05626)), [ProMediate](https://www.microsoft.com/en-us/research/articles/evaluating-proactive-ai-mediators-in-multi-party-conversation-with-promediate/), ModeratorLM ([2606.13544](https://tldr.takara.ai/p/2606.13544)).

Jarvis confirms the design (classifier → check → deterministic gate → generator). Egg Head differs in setting (a live operational incident, not a paper discussion), in ground truth (claims are checked against the systems, not a document) and in model size (a 2B decision model asked easy yes/no questions, no training).

## How it works

```
 call audio ─► transcript (script or Amazon Transcribe streaming)
                 │ each line, and live partials
                 ▼
   Decider 2B: is it a claim? (four yes/no layers, latest line only, Platt-calibrated)
                 │
   code: resource by alias ─► Decider: which of that resource's checks? (option orders averaged)
                 │
   code: run the check, compare with the claim ─► claim ledger
                 │ contradicted, and not corrected by the call within one turn
                 ▼
   Investigator (a coding agent on Bedrock, in a real terminal) takes a second look
                 │ confirmed
                 ▼
   speak gate (code over Decider: self-repaired? finished? silence, cost, cooldown)
                 │ open
                 ▼
   one grounded sentence (template or Bedrock) ─► Amazon Polly
```

Decider makes the judgment calls; code does everything deterministic; Bedrock writes text or investigates, and only when needed. A Strands `InterventionHandler` (`SpeakGuard`) denies model calls while the gate is closed, so silence never reaches Bedrock. Egg Head also replies when spoken to (once the speaker has finished), takes a question nobody answers in 2.5 s, and barges in when someone is about to act on a wrong claim.

Two reusable patterns come out of it: a **claim-check router** (claim → check over a registry → resource from a live inventory) and a **speak gate** (self-repair, end of turn, silence and cost, wired as an `InterventionHandler`).

## Results

From the Decider research campaign ([`research/decider/FINDINGS.md`](research/decider/FINDINGS.md); 273 lines we labelled, held-out split scored once):

| Task (held-out) | Decider pipeline | Baseline |
|---|---|---|
| Is it a claim? | F1 0.89 (P 0.88 R 0.91) | keyword regex F1 0.64 |
| Claim → right check and resource | F1 0.81 (P 0.81 R 0.81) | keyword route F1 0.72 |
| Speak gate | F1 0.83, 3 false interrupts | silence ≥ 1.5 s F1 0.78; always speak F1 0.76 |
| Latency per line | p50 ~90 ms server-side | Nemotron 120B on every line: p50 1.2 s, p95 3 s |

The 120B LLM is more accurate (claim F1 0.98) but about 13× slower per line and costs per token; Decider's case is latency, cost and calibrated confidence. The TypeScript router reproduces the research numbers exactly (`npm run replay -- heldout`). The research also gave ten reusable rules for prompting Decider (yes/no over N-way choices, average option orders, latest line only, calibrate then threshold, code first).

## Run it

Node ≥ 22.

```bash
npm install
npm test                       # no network
npm run demo -- --rehearsal    # the meeting demo offline: http://localhost:8787, press Start
npm run demo                   # live: hosted Decider, pi on Bedrock, Polly voices (.env for AWS)
```

[`AGENTS.md`](AGENTS.md) has the layout, the Decider and Bedrock setup, every demo flag and how the parity tests work; [`demo/RECORDING.md`](demo/RECORDING.md) is the video run sheet.

## Status and to do

Done: runtime (TypeScript on Effect 4), research router and gate ported with parity tests, Bedrock writer and escalation, agent mode with the pi Investigator, the Bridge reworked as gather / reduce / interpret with a TLA+ model of when it speaks (`spec/`), meeting page and dashboard, Polly voices, Transcribe mode.

Open:

- [ ] First live run of agent mode: the new Decider questions (`addr`, `ask`, `act`) have no research numbers yet; check each line's `expect` on the dashboard. The runs that need a network are written up in [`docs/live-work.md`](docs/live-work.md).
- [ ] Live-mic mode so real people can run the demo.
- [ ] Choose the pattern tag: `#policy` (speak gate, recommended) or `#tool-selection` (claim-check router).

Submission:

- [ ] Record and edit the demo video (under 3 minutes)
- [ ] Builder Center article: the agent, the decision handed to Decider, measured gains
- [ ] Make the repo public (keep it unpublished until submission)
- [ ] Tags: `#strands-decider-2b` + the pattern tag
- [ ] Submit before 12:29 PM Colombo, Sat 24 Oct

## Sources

- Hackathon: https://builder.aws.com/build/hackathons/4f50957c-1d08-37ab-b11c-97516b9adeb4/agent-experience-hackathon-strands-decider
- Strands Decider: https://github.com/strands-labs/strands-decider · [inference docs](https://github.com/strands-labs/strands-decider/blob/main/docs/inference.md) · [Strands example](https://github.com/strands-labs/strands-decider/tree/main/examples/strands)
- InterventionHandler API: https://strandsagents.com/docs/api/python/strands.interventions.handler/index.md
- End-of-turn prior art: https://livekit.com/blog/solving-end-of-turn-detection · https://huggingface.co/soniqo/Smart-Turn-v3.2-ONNX · https://www.assemblyai.com/blog/turn-detection-endpointing-voice-agent · https://deepgram.com/learn/build-voice-agent-pipecat-deepgram-flux-stt-tts
- The Augmented AI: https://www.producthunt.com/products/the-augmented-ai-live-ai-cortex/launches/the-augmented-ai
