/**
 * Bounded exhaustive exploration of the REAL reducer (no Effect, no clock): inputs from a small alphabet
 * mirror the TLA+ nondeterminism (line kind x claim x found x floor open; job outcome incl. Unknown/Failed/TimedOut;
 * SpeechEnded; Sweep; Partial). Depth 6, two claims on two resources. Every Law holds on every transition;
 * the drain properties hold on every reachable state.
 *
 * Spec-sync: parse the claim-phase table in spec/Bridge.tla's header and fail unless it lists exactly
 * Claims.Phase tags (+ Standing basis values), Floor.Phase tags, and the Input tags equal the TLA action names
 * in the header table (Hear=LineUnderstood, Tick=Silence, Barge=PartialHeard, Report=JobDone, Answer=JobDone(request), Spoke=SpeechEnded).
 * A list in two places fails the build when they disagree; neither is hand-edited alone.
 */
import { describe, it } from "@effect/vitest"
describe("Laws", () => {
  it.todo("every Law holds on all reachable transitions to depth 6")
  it.todo("drain: AckIsAnswered and ConfirmedIsResolved from every reachable state")
  it.todo("spec/Bridge.tla header table matches Claims.Phase, Floor.Phase and Input tags")
})
