# Explorer: the demo runner, agent, voice and run files

_A delegated report from 23 Oct 2026, kept as written. Line numbers are at the commit it names or at 7dd7885 (before this PR). Treat claims as findings, checked where docs/handoff/continue.md says so._

## Egg Head demo, end to end, and hook points for scripted verification

### Components Found
- /home/user/Egg-Head/demo/server.ts: plain `node:http` server and CLI. It owns the run lifecycle, the SSE streams, the `history` buffer, the run-file writer and the `/agent/report` endpoint.
- /home/user/Egg-Head/demo/Run.ts: the real-time call runner `run(call, {mode, writer, agent, bedrockCalls, publish})`. It also defines the `Call` schema, the `Message` union, `DeciderMeter` and `Floor`.
- /home/user/Egg-Head/demo/Rehearsal.ts: `rehearsalDecider(call)`, a `ScriptedDecider` driven by each line's `decider` hints.
- /home/user/Egg-Head/demo/Agent.ts: `AgentTerminal`, a node-pty terminal running the coding agent (pi by default). It provides an `Investigator` layer and holds the `Report` schema and the prompts.
- /home/user/Egg-Head/demo/Voice.ts: `Voice` (Polly with a disk cache), `rehearsalVoice` (silent clips), `estimateMarks`, `wav`, and `transcribe` (Amazon Transcribe streaming).
- /home/user/Egg-Head/demo/agent/: `SYSTEM.md` is the agent prompt. `bin/egghead` POSTs the report to `$EGGHEAD_REPORT_URL`. `bin/aws` is a stand-in AWS CLI that reads data/aws.json. `rehearsal.ts` is a pi extension that provides a scripted model, "rehearsal/scripted".
- /home/user/Egg-Head/src/Investigator.ts: the `Investigator` service (`name`, `confirm`, `answer`) and the model-free `direct` implementation.
- /home/user/Egg-Head/src/Speaker.ts: `Writer` (`Writer.template`) and `SupportError`.
- /home/user/Egg-Head/src/Bedrock.ts: the optional Bedrock writer and escalator (`--writer bedrock`). I did not go deep on it.
- /home/user/Egg-Head/scripts/record-demo.ts: an existing script that spawns the server, drives it with Playwright, and reads `/history`.
- /home/user/Egg-Head/data/calls/checkout-incident.json: the only call script, with 17 lines.

### Flow

**1. Startup (server.ts)**
- `parseArgs` at server.ts:34-47.
  - Flags are `--mode text|transcribe`, `--writer template|bedrock`, `--agent pi|none`, `--agent-cmd`, `--agent-model`, `--agent-timeout` (default 60 s), `--rehearsal`, `--call`, `--port` (default 8787), and `--autostart`.
  - `--rehearsal` forces mode to text and writer to template (lines 49-50).
- The call JSON is decoded with the `Call` schema (line 51).
- The agent terminal starts once at server boot (lines 62-79). A custom `--agent-cmd` or pi gets a `ManagedRuntime` holding `AgentTerminal`. `--agent none` means no Investigator.
- The server then listens and fires an uncached warm-up Decider request (lines 217-222). It logs "Decider warm (N ms)", and `--autostart` calls `start()` after that.

**2. HTTP routes (server.ts:167-216)**
- `/` serves meeting.html and `/dashboard` serves dashboard.html.
- `/web/*.js|css|svg` serves the static page assets.
- `/vendor/xterm*` serves xterm.
- `GET /config` returns `{title, agent, rehearsal, mode, writer, people}`.
- `GET /history` returns the JSON array of stamped messages for the current run.
- `GET /events` is SSE. It replays all of `history` and then streams live. Each frame is `data: <JSON Message + at>\n\n`. There is no `event:` or `id:` field, and the stream never closes by itself.
- `GET /pty` is SSE of the terminal as `{d: "<chunk>"}`. It sends the scrollback first.
- `POST /pty/resize` takes `{cols, rows}`.
- `POST /agent/report` takes JSON and returns 200 "ok", or 404 "no job is waiting for that task".
- `GET /audio/<16hex>.wav` serves a clip from demo/out/audio.
- `POST /start` returns 204 and calls `start()`. It is a no-op if a run is already in progress.

**3. `start()` (server.ts:115-147)**
- It sets `running`, `runStarted = Date.now()`, and clears `history`. It broadcasts `{type:"reset"}` as an SSE frame, which is not stored in history.
- It publishes `status` messages: "Rehearsal: scripted Decider" or "Waking up Decider…", then "Decider ready (N ms)". It awaits `warmUp` with `Effect.timed`.
- It calls `run(call, …)` with a fresh `runLayer()` (lines 95-106). That layer holds Bridge, DeciderMeter wrapping the Decider, MockSource, `Floor.holdWhileWriting` wrapping the Writer, Voice or rehearsalVoice, and the Investigator when an agent exists.
- It uses `Effect.runPromise` on the real runtime.
- In `.finally` (lines 139-146) it clears `running` and writes `demo/out/runs/<ISO time with : and . replaced by ->.json`. The shape is `{mode, writer, agent, rehearsal, call: <path string>, history}`, pretty-printed with indent 1.
  - `history` is the array of Messages, each with an extra `at` field in ms since `runStarted`.
  - The ending frame is `{type:"done"}`. On exception, `done` is published and the error is logged to the console.
- The `demo/out/` directory is gitignored and does not exist in this checkout.

**4. Message types (Run.ts:41-52)**
- `meta {title, mode, writer, agent, lines, people}`
- `line {index, speaker, text, audio, durationS, expect, marks}`
- `cut {index, speaker, text}`
- `heard {index, speaker, text}`
- `event {index, event}`. The event is `Schema.toCodecJson(Event)` from src/Bridge.ts. It carries `turn`, `said` (Option encoded), `saidKind`, `claim`, `agent` (AgentNote: task, job, action dispatched|reported, detail, by, ms), `request`, `gateScores`, `note`, and so on.
- `floor {index}`
- `hold {index, on}`
- `status {text}`
- `egghead {index, text, audio, durationS, marks, kind}`, where kind is flag|ack|answer|barge|line
- `stats {lines, deciderBatches, deciderMsP50, bedrockCalls, agentTasks, spoke}`
- `done`

**5. Text-mode runner (Run.ts:258-273)**
- Voice clips for every line are pre-synthesized (line 125).
- For each line i, `playLine(i)` (lines 220-252) runs these steps.
  - `holdForEggHead` polls every 100 ms until `Floor.until` has passed.
  - It sets `current` and `lastEnd=-inf`, then publishes the `line` message.
  - It forks a partials fiber. For each word k, it sleeps until `startMs + words[k+1].time + 250 ms`, then calls `bridge.partial(speaker, wordsSoFar)`. If the result has `said` Some, the line is cut: it resolves the Deferred with the partial text.
  - `Effect.raceFirst` races `sleep(clip.durationS)` against the cut Deferred.
  - It sets `lastEnd = now`. On a cut it publishes `cut`.
- Back in the loop: sleep ASR_DELAY 300 ms, then publish `heard`.
- Then it forks `hear(i, speaker, text, silence)` without waiting. `hear` appends the line index to `lineOfTurn` (the Bridge turn to line index mapping) and calls `bridge.hear`.
- It sleeps the rest of the line's `pause` (a cut line uses a pause of 0.2 s).
- If the line has `waitForEggHead`, it joins the hearing fiber and then polls `waitForEggHead` (lines 202-211). That poll holds while `bridge.pending > 0` or Egg Head is still speaking, for at most N s (0 means 30 s). It publishes `hold on` and `hold off`.
- A background ticker (lines 187-194) runs every 250 ms. When `now - lastEnd >= 0.5` it calls `bridge.tick(now - lastEnd)`. This is the VAD-style silence signal. A `floorWatch` fiber (lines 175-184) polls every 100 ms and publishes `floor`.
- `bridge.changes` (a PubSub stream) feeds `onEvent` (lines 149-169), which does the following.
  - It maps `ev.turn` to a line index through `lineOfTurn` and publishes `event`.
  - If `ev.said` is Some, it sets the humans' wait to now+30, calls `voice.speak("Egg Head" voice, text)`, increments `spoke`, sets the wait to now + durationS + 0.6, and publishes `egghead`.
  - It then publishes `stats`.
- End of run (lines 328-338): `joinAll(hearing)`, `waitForEggHead(last, 20)`, `holdForEggHead`, sleep 1.5 s, interrupt the ticker and floorWatch, publish the final `stats` and `done`, and return `bridge.state`.
  - server.ts logs "done: N spoken, M agent tasks, K escalations" from that returned state.

**6. Agent loop (Agent.ts and Bridge.ts)**
- In Bridge.ts, `confirmClaim` (line 228) and `answerRequest` (line 265) call `inv.confirm(task, item)` or `inv.answer(task, q)`. They run inside `background()` (lines 208-226), which is forked in the Bridge scope.
- Fallback: `Effect.catch` on any failure runs the fallback and records `by = "direct (agent failed)"`.
  - For confirm, the fallback is `Effect.succeed({status: item.status, fact: factOf(item)})`, i.e. the fast check's own result.
  - For answer, the fallback is `direct(source).answer`, which picks a check from `aliasHits` and `QUESTION_CHECKS` regexes. It fails with SupportError if no resource is named.
  - If the fallback itself fails, `catchCause` logs the error and the job result is lost.
- The result is committed under the Bridge lock as an `(agent)` event with `agent.action = "reported"`, `by`, and `ms`.
- `AgentTerminal.submit` (Agent.ts:149-168) runs under a Semaphore(1), so jobs run one at a time.
  - It registers a Deferred in the `waiting` map by task number.
  - It "types" the prompt into the pty, 4 characters per `sleep 10 ms`, then `sleep 150 ms` and `\r`.
  - It awaits the Deferred with `timeoutOption(timeoutS)`.
  - On timeout it writes ESC to the pty and fails with `SupportError(investigate)`, which triggers the fallback above.
  - On success it runs `settle` (up to 6 s wall-clock, waiting for 800 ms of terminal quiet).
- Prompts: `confirmPrompt` and `answerPrompt` (Agent.ts:67-74). The text contains the literal "verify a claim" for confirm tasks.
- The agent runs `aws …`. `bin/aws` builds its answers from data/aws.json and uses `Date.now()` for relative times.
- The agent then runs `egghead report <task> --status … --fact "…"` or `egghead answer <task> "…"`. `bin/egghead` POSTs `{kind, task, status, fact}` or `{kind, task, answer}` to `/agent/report`.
- The server calls `agent.report(body)`, which decodes with `Report` and completes the Deferred. It returns false, giving a 404, if the body is invalid or no job is waiting for that task.
- A wrong report kind for the job fails with `SupportError`, which also triggers the fallback.

**7. Rehearsal (`--rehearsal`)**
- Decider: `rehearsalDecider` (Rehearsal.ts:249-260).
  - `ScriptedDecider.layerWith` answers via `answerLine(request, hints)`, where the hints are the `decider` field of the call line whose text equals the request's latest utterance.
  - For partial transcripts it uses the line that starts with that text (prefix match with trailing "—" stripped). Anything else gets `{}`, i.e. not a claim.
  - Latency is a random `Effect.sleep` of 120-300 ms using the Effect Clock.
  - `warmUp` also runs on this layer (a warm-up request has no transcript, hence `latestOrEmpty`).
- Voices: `rehearsalVoice` returns silence of an estimated length, with `estimateMarks` timings (about 70 ms per word plus about 260 ms after punctuation, and so on). It writes silent WAVs to demo/out/audio.
- Agent model: the pi extension demo/agent/rehearsal.ts is a scripted model.
  - Step 0 it emits a bash `aws …` command chosen by regexes (RESOURCES and CHECK_WORDS) over the quoted text.
  - Step 1 it emits `egghead report|answer` using status and evidence from data/world.json.
  - It sleeps 700-1300 ms of wall-clock time.
  - pi itself, the pty, `bin/aws` and `bin/egghead` are all real.
- Checks: `MockSource.layer()` runs against data/world.json in all modes. The writer is `Writer.template`.
- Not replaced in rehearsal: the Bridge, the Gate and Router, the Investigator wiring, the HTTP server, the SSE and the run file.

**8. Transcribe mode (`--mode transcribe`, Run.ts:274-326)**
- This is real-AWS-only; rehearsal forces text mode.
- Each line's PCM is sent in 100 ms chunks, paced with `setTimeout(100)`, plus silence chunks for the line's `pause`. A waitForEggHead hold is applied after the pause.
- `transcribe()` in Voice.ts uses `StartStreamTranscription`. It skips results where `IsPartial` is true and yields only final segments `{text, startS, endS}`.
- Each final segment is mapped to a line via `offsets.findLastIndex(o <= startS + 0.05)`. The server publishes `heard` and calls `hear(i, speaker, seg.text, silence)`.
- **Partials do not feed `Bridge.partial` in Transcribe mode.** Only text mode calls `bridge.partial`, using Polly word marks. The Bridge hears final segments only.
- In this mode `lastEnd` is set from `Date.now()`.

**9. The `expect` field**
- It is a required `Schema.String` on every line. It is a human-readable annotation, for example "silent: …", "flag: …", "speak: …", "ack: …", "answer: …", "barge: …".
- Code only copies it into the `line` message (Run.ts:216), and demo/web/store.js:121 stores it for the dashboard to display.
- It is not asserted anywhere. It is free text, not a machine-checkable enum, so a verifier would have to parse its prefix, or the call JSON would need a structured expectation.
- The `decider` hints are the only scripted input to the rehearsal Decider.

### Real time and TestClock feasibility
- `Clock.currentTimeMillis` and `Effect.sleep` are used throughout Run.ts: `now`, the ticker, the floor watch, the hold polling, the partials scheduling, the ASR delay, the pauses, and `Floor.holdWhileWriting` (Clock now + 30 s). These would respond to `TestClock`.
- The following are wall-clock based and would not move under TestClock:
  - `server.ts` stamps `at` with `Date.now() - runStarted`, and `Date.now()` is used for the run-file name.
  - `Agent.ts` uses `Date.now()` in `settle` and `lastOutput`.
  - The pty is a real process: node-pty plus pi, `bin/aws` (`Date.now()`), and `bin/egghead` (an HTTP `fetch`).
  - The rehearsal pi model sleeps 700-1300 ms on a real `setTimeout`.
  - `Effect.timeoutOption(timeoutS)` in `submit` is an Effect timeout, so it is TestClock-compatible if the Clock is shared.
  - `Voice.layer` uses real Polly and `fs`. In Transcribe mode `pace()` is `setTimeout`, so Transcribe mode cannot run under TestClock.
  - Warm-up uses `Date.now()` in its input.
- Whether `run()` could run under TestClock:
  - It could, if the following are provided: a `Voice` stub with fixed clips (so no real Polly or fs), `ScriptedDecider`, `Investigator.direct` or a scripted Investigator, `MockSource`, and `Writer.template`.
  - Both `Floor` and `DeciderMeter` come from the Effect environment, so they are fine.
  - `run()` itself depends only on `Bridge`, `Voice`, `DeciderMeter` and `Floor`, plus a `publish` callback. That `publish` callback is the natural collection point for a test: it receives every Message, and `at` is added by server.ts, not by `run()`.
  - But `run()` is not exported through any test today, and `Floor.layer` plus `DeciderMeter` need a layer built like `runLayer`.
  - Existing tests in test/Bridge.test.ts and test/Bedrock.test.ts already use `TestClock.adjust` with `ScriptedDecider`. No test imports demo/Run.ts or demo/Rehearsal.ts.
  - The rest of the pipeline (Voice, Agent) must be faked, because `server.ts` has top-level side effects and cannot be imported without starting a server and spawning pi.

### Hook points for scripted, repeatable verification (summary)
1. Black-box over HTTP, with `--rehearsal --port N --agent none` (deterministic apart from Decider latency jitter) or with the pi rehearsal model (real pty, wall-clock about 3 minutes):
   - Start with `POST /start` or `--autostart`, and observe via `GET /events` (SSE) or poll `GET /history`.
   - Wait for `{type:"done"}`, then read `demo/out/runs/*.json` (same history plus `call` and `rehearsal`).
   - Assert on `event`, `egghead` (`kind`, `text`), `cut`, and `stats`.
   - record-demo.ts already follows this pattern, but it needs a browser and ffmpeg.
2. In-process: build the layer stack in a test (`Bridge.layer` with `ScriptedDecider` from `rehearsalDecider(call)`, `MockSource`, `Writer.template`, a stub `Voice`, and `Floor`), call `run()` with a collecting `publish`, and drive it with `TestClock`. The Voice stub and `Investigator.direct` or a scripted investigator remove the pty. This would be the repeatable path.
3. Agent seam: `AgentTerminal.report(body)` and `Investigator` are the injection points, either by POSTing to `/agent/report` with the task id from the `event.agent.action == "dispatched"` frame, or with a stub Investigator.

### Files Read
/home/user/Egg-Head/AGENTS.md (head), demo/server.ts, demo/Run.ts, demo/Rehearsal.ts, demo/Agent.ts, demo/Voice.ts, demo/agent/SYSTEM.md, demo/agent/rehearsal.ts, demo/agent/bin/egghead, demo/agent/bin/aws (first 60 lines), src/Investigator.ts, src/Speaker.ts, scripts/record-demo.ts, data/calls/checkout-incident.json, src/Bridge.ts (lines 140-300 and 560-590, plus greps), test/helpers.ts (head). src/Bedrock.ts was only grepped for exports.

### Boundaries
- Mostly one-time-per-run state is module-level in server.ts (`history`, `clients`, `running`, `runStarted`), so one server means one run at a time. Concurrent `/start` is ignored. A second run clears history, and the previous run's file is only written on completion.
- The agent terminal outlives runs, and its `waiting` map and scrollback persist across runs. A stale job from an earlier timed-out run could still be in flight.
- If `done` never arrives (a hang), no run file is written, since the file is written only in `.finally` of the run promise.

### Non-Obvious Things
- The run file is written by server.ts:142-145, not by a separate class. The JSON holds `call: args.call`, the path string (not the call contents), plus `history` with `at` offsets.
- The `reset` SSE frame is never in `history` or the run file.
- `Floor.until` is in Clock seconds. The writer wrapper sets `+30` the moment writing starts, and `onEvent` then replaces it with the actual clip duration plus 0.6 s.
- The rehearsal Decider keys on exact text equality, so a call script whose lines the Bridge rewrites (e.g. partial text with "—") relies on the prefix fallback. Lines without `decider` hints are silently "not a claim, not a question", so lines like #5 (waitForEggHead) simply have no hints.
- `waitForEggHead: 0` means 30 s (`|| DEFAULT_WAIT_S`). In Transcribe mode the wait is applied inside the audio generator.
- In text mode a cut line is sent to the Bridge as the partial text plus "—", and its pause is shortened to 0.2 s.
- The rehearsal agent decides the resource by regex on the quoted claim text. Claims that match none fall back to `orders-api`, so the rehearsal agent reports are scripted to the world.json data, and are independent of what the Decider asserted.
- `AgentTerminal.submit` timeout (default 60 s) is much longer than the humans' waits (30 s defaults), so a stuck agent shows up as a `hold` of up to 30 s, not a fallback.
- The `Report` schema `status` uses `Status` from src/Checks.ts (healthy|degraded|down|changed|unchanged).
- Anything in demo/ other than Run.ts, Rehearsal.ts and Voice's pure helpers can't be imported in tests without side effects: server.ts has top-level `await` and starts a listener, and Agent.ts imports node-pty.
- The rehearsal Decider imports from `test/helpers.ts` (`answerLine`, `latestOf`, `Line`), so demo code depends on test code.

### Checkout-incident-only vs generic
- Generic: the `Call` schema, the Run.ts runner, the server, the `decider`-hints mechanism, and `--call path`.
- Checkout-specific:
  - the default `--call` path;
  - the voice map (Ruth, Stephen and so on, in the JSON);
  - the rehearsal agent's regex tables (RESOURCES and CHECK_WORDS in demo/agent/rehearsal.ts: orders-db, payments-db, checkout-queue, orders-api, payments-api, auth-service);
  - the data in data/world.json and data/aws.json (MockSource and `bin/aws` use the incident world, not the call);
  - `SYSTEM.md` (the account, the cluster, the named services);
  - `QUESTION_CHECKS` and `aliasHits` (in src/Router.ts) for the direct fallback.
- A different call script would run in rehearsal only if its resources match those tables and the mock world.

### Open Questions
- Whether `src/Bedrock.ts` writer and escalator paths need coverage in verification: I did not read them.
- Whether the Bridge in agent mode has more `Clock` or `sleep` dependencies than I saw. I read only Bridge.ts lines 140-300 and 560-590.
- Do the web pages' `store.js` reducers (demo/web/store.js, tree.js, dashboard.js) need to be part of the verification? I only saw that `expect` is stored there.
- The exact shape of the encoded `Event` (the `event` field) needs reading from src/Bridge.ts lines 40-135 if assertions will be made on it.
- Whether the repo's pi version is installed in node_modules (so the pty path can run in this environment).
