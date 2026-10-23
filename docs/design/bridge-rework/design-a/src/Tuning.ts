/** DELTA to src/Tuning.ts: new knobs only, defaults in Gate.ts / Conversation.ts / Floor.ts as today. */
export interface TuningAdditions {
  readonly parked: number // P(a line parks a claim's resource)  -- 0.5 for the regex rule (p is 0 or 1)
  readonly floor: {
    readonly quietAfterSpeechS: number // 3.0: "a few seconds" of silence after Egg Head ENDED that opens the next line
    readonly maxSpeechS: number // 20: Bridge-owned safety if the caller never calls spoke()
    readonly composeDeadlineS: number // 10: then the code line is used
  }
  readonly jobs: { readonly confirmS: number; readonly answerS: number; readonly recheckS: number } // 45 / 45 / 8, from dispatch (queue time counts)
}
