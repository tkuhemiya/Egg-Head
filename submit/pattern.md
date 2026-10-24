# Pattern: a speak gate for an agent in a group conversation

Pattern tag: `#policy`. Classify each incoming line before the agent acts on it, and deny the model call when the agent should stay quiet.

Use it when your agent listens to people talking to each other (a call, a meeting, a busy chat channel) and should speak only when it has something worth saying and there is a gap to say it in.

## The questions

Ask them together in one Decider batch on a short tagged transcript. All are yes/no; we found yes/no beat N-way choices by a wide margin (macro-F1 0.93 vs 0.70 on our dev set). Wording is exact, from `src/domain/Questions.ts` and `src/domain/Conversation.ts`.

| Key | Question | Threshold |
|---|---|---|
| `rep` | After the flagged claim, did someone on the call already say it was wrong, or question whether it was right? Agreeing with it is not a correction. | 0.45 (keyword and ledger rules decide most cases first) |
| `fin` | Has the latest speaker finished their turn, so that someone else could start talking now? | 0.5, after Platt scaling. Raw answers all sat below 0.5 |
| `addr` | Is the latest speaker talking to Egg Head, the AI assistant, and asking it to check, answer or do something? | 0.25, only after code saw the agent's name |
| `ask` | Is the latest speaker asking the people on the call a question about the current state of a system, service, metric or recent deploy? | 0.3, only after code saw a "?" |

`fin` and `rep` have held-out numbers (speak gate F1 0.83 on 18 cases). `addr` and `ask` don't yet; their thresholds are hand-set.

In Effect's `DecisionModel` terms, which `src/runtime/Decider.ts` implements for Decider:

```ts
export const turnQuestions = Decision.make({
  input: Schema.String,
  decisions: {
    rep: Decision.probability({ instructions: SELF_REPAIRED }),
    fin: Decision.probability({ instructions: FINISHED }),
    addr: Decision.probability({ instructions: ADDRESSED }),
    ask: Decision.probability({ instructions: ASKS })
  }
})
```

## The gate

Decider's answers are inputs, not the decision. `Gate.decide` in `src/domain/Gate.ts` is a pure function. It speaks only if every reason holds, and it reports the first one that blocks:

- `persisted`: at least one turn passed since the claim (gives people a chance to fix it themselves)
- `not_repaired`: nobody corrected it (ledger, keyword, then `rep`)
- `min_silence`: 0.5 s of silence, whatever Decider says
- `floor_open`: `fin` says the turn is over, or 1.2 s of silence
- `worth_it`: the problem is at least "moderate" for the check that disagreed
- `cooldown`: 30 s since the agent last spoke unprompted

## The wiring in a Strands agent

`SpeakGuard` (`src/runtime/Bedrock.ts`) is an `InterventionHandler`. It reads the gate and denies `beforeModelCall` while the gate is closed, so a closed gate never reaches Bedrock and costs nothing.

```ts
export class SpeakGuard extends InterventionHandler {
  readonly name = "egghead-speak-guard"
  constructor(private readonly gateOpen: () => string | null) { super() }
  override beforeModelCall(_event: BeforeModelCallEvent) {
    const reason = this.gateOpen()
    return reason ? InterventionActions.deny(reason) : InterventionActions.proceed()
  }
}

// gateOpen returns the blocking reason, or null when the gate is open
const agent = new Agent({ model, interventions: [new SpeakGuard(() => blockedReason())] })
```

`test/Bedrock.test.ts` runs it on a real Strands `Agent` with a counting model: closed gate, zero model calls and the reason in the result; open gate, one call.

In the Egg Head demo itself, the runtime only asks Bedrock to write after the gate opens, so the guard is a second lock rather than the first. If you lift this into your own agent, the guard is the part to copy.

## Notes from using it

- Ask the latest line, not a long window. Claim detection got worse as we added context (mean AUC 0.91 with one line, 0.77 with six).
- Calibrate before you threshold. Decider's raw probabilities rank well but sit in a narrow band.
- Let code do what code can. A rule for the agent's name, "hold on", or a trailing "and" matched or beat the model, so the model only confirms what a rule flagged.
- The hosted endpoint returns 429 on a third concurrent request and 422 above 8 questions per batch. Queue requests and split batches.
