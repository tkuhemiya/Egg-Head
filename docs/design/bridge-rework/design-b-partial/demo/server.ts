/**
 * demo/server.ts (delta). The server barely changes; that is the point of keeping the Bridge's
 * surface the same size.
 *
 * - runLayer(): drop `Floor.holdWhileWriting` and `Floor.layer` (Speech owns "Egg Head is
 *   writing"); add nothing else. `Reading.rules` is the Bridge's default.
 *     const writing = support                       // was Layer.provideMerge(Floor.holdWhileWriting, ...)
 *     return Bridge.layer.pipe(Layer.provideMerge(Layer.mergeAll(decider, source, writing, sound, investigator)))
 * - The end-of-run log line reads the new state:
 *     `${state.events.filter((e) => e.said._tag === "Some").length} spoken, ${state.jobs.length} agent jobs, ...`
 * - The page's "floor" message (Egg Head taking the floor while Bedrock writes) is published by
 *   the call loop when `bridge.speech` turns Writing, not by watching a +30 s hold.
 * - /agent/report: unchanged (keyed reports, commit b629bba). The Report schema gains the
 *   `unknown` variants (Investigator.Finding / AnswerResult); demo/agent/bin/egghead gains
 *   `--unknown "<why>"`, and SYSTEM.md tells the agent to use it when no data settles the claim.
 * - demo/Agent.ts: `settle` (up to 6 s after a report) moves to before typing the next job, so
 *   it no longer delays the result reaching the Bridge (finding 9, part 2). The Bridge's job
 *   deadline covers queue time behind the terminal's Semaphore; the terminal's own `timeoutS`
 *   stays as the agent-side bound and must be <= Tuning.jobs.confirm.
 */
export {}
