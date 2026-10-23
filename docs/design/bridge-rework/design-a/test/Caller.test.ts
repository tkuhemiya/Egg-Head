/** Sketch of the tests that read as the spec. Each finding is a failing test first, then fixed by the design. */
import { describe, it } from "@effect/vitest"
describe("agent mode", () => {
  it.todo("tentative barge on a Checking claim: speech.certainty=tentative, basis=fastCheck, no new job; never on a corrected claim")
  it.todo("tentative barge on a Fresh claim starts the confirm job in the same event (Dispatched move)")
  it.todo("investigator reports Unknown on a claim: no speech, Closed{undetermined} move with a note")
  it.todo("investigator reports Unknown on a question: acked, then answered with the unable line")
  it.todo("investigator fails then direct fails: request Ready{Unable}; ack is always answered")
  it.todo("confirm times out: a recheck job (via direct) is Dispatched; still contradicting => Standing couldNotConfirm, tentative flag")
  it.todo("parking a line about orders-db closes only orders-db claims; payments-api claim still flagged")
  it.todo("an ack then an answer: second line waits for a human turn or quietAfterSpeechS after spoke(); cooldown not consulted")
  it.todo("tick during Composing does nothing; hear during a slow writer is not blocked by tick/partial/jobDone")
  it.todo("a failed hear still emits an event and releases analysing")
  it.todo("commit interrupted: state.events and changes agree (seq dense)")
})
