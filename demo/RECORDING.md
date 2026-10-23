# Recording the demo video

A real screen recording of a live run, of the meeting page. The run is not
staged: the call is a script with synthetic voices, but every decision on screen is Decider
answering live, and the terminal is pi on Bedrock running commands.

## Before you record

1. `.env` has `AWS_BEARER_TOKEN_BEDROCK` (or a profile), `AWS_REGION`, and `EGGHEAD_VOICE_REGION`
   set near you (ap-south-1 from Colombo). pi uses the same credentials. Optional:
   `EGGHEAD_AGENT_MODEL` (default: `EGGHEAD_MODEL_ID`, else `nvidia.nemotron-nano-3-30b`).
2. Rehearse offline first: `npm run demo -- --rehearsal`, open http://localhost:8787, press Start.
   Same page, same timing, no network.
3. One live dry run: `npm run demo`, press Start, let it finish. This caches every voice clip and
   its lip-sync marks, and tells you how long pi takes on your model. Check
   http://localhost:8787/dashboard afterwards: each line's `expect` in `data/calls/checkout-incident.json`
   says what should have happened.
4. If pi is slow (more than ~10 s a task) or fumbles the `aws` commands, try
   `--agent-model qwen.qwen3-coder-30b-a3b-v1:0` (a fast coding model, still cheap) if your region has it.

## Recording setup

- Browser window full screen at 1440×900 or 1920×1080. Open `http://localhost:8787/`.
  The page uses no camera or microphone.
- Screen recorder that captures **system audio** (the voices play in the browser). On macOS, QuickTime
  cannot; OBS (macOS 13+ captures app audio) can. Record your own mic as a separate track if you narrate.
- Restart the server right before the take (`Ctrl+C`, `npm run demo`) so the terminal starts clean.

## Run sheet (about 2 minutes of call)

| When | On screen | What it shows |
|---|---|---|
| 0:00 | Priya asks what everyone sees; Jordan answers; Jordan's "500s" claim is true | Egg Head stays out: someone answered, and a true claim needs no LLM (dashboard: "checks out") |
| 0:11 | Sam: "orders DB is fine" | Fast check contradicts it. Egg Head waits one turn, then hands it to pi: the terminal grows, pi runs `aws cloudwatch ...` and `egghead report` |
| ~0:20 | Pause after Priya | "Quick flag, Sam: …" in the gap, with the numbers pi found |
| 0:36 | Lee: "we didn't deploy"; Mei: "hold on, are you sure?" | Contradicted, but the call corrected itself before any LLM call: stays quiet |
| 0:48 | Priya: "Egg Head, can you check the, uh…" (pause) | Waits: Priya has not finished. A silence detector would have jumped in at 1.2 s (the feed says so) |
| 0:52 | "…the checkout queue? How backed up is it?" | "On it, Priya." pi checks SQS; Egg Head answers at the next gap |
| 1:13 | Lee asks the call about payments deploys; silence | Nobody answers in 2.5 s: "I can check that." pi checks ECS; answer |
| 1:29 | Jordan blames the payments API; Priya: "restart the payments API—" | Barge-in: Egg Head cuts Priya off before a wrong restart |

Things to say over it (your words, not a script): any coding agent works in that terminal
(`--agent-cmd`); the same brain drops into any meeting app, since it only needs the transcript
and a way to speak; Decider answered every line in a few hundred ms while the LLM ran a handful of
times (the counters at the top right).

## After the call

Switch to http://localhost:8787/dashboard: pick a line in the transcript; the pane beside it is
that line's claim, agent work, question, or why Egg Head stayed quiet. `?replay` shows the last
run without the server running a new one.
