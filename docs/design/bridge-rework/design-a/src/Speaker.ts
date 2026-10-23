/** DELTA to src/Speaker.ts: the Writer sees a claim and how sure to sound; it no longer receives a LedgerItem. */
import type { Effect } from "effect"
import type { Claim } from "./Claims.ts"
import type { Voice } from "./Ids.ts"
export declare class SupportError { readonly operation: "write" | "route" | "investigate" }
export interface WriterShape { write(claim: Claim, voice: Voice): Effect.Effect<string, SupportError> }
// A Writer failure becomes Input.Composed{text: None}: the code line is spoken instead of failing hear.
