/** DELTA to src/Conversation.ts: Request moves to Requests.ts; line builders take a Voice; two new lines. */
import type { Voice } from "./Ids.ts"
export declare const flagLine: (speaker: string, fact: string, voice: Voice) => string // firm: "Quick flag..." | couldNotConfirm: "I could not confirm this further, but my check shows..."
export declare const bargeLine: (speaker: string, fact: string, voice: Voice) => string // doubleChecking: "Sorry to cut in, X: my quick check shows ..., I'm double-checking." | firm: as today
export declare const retractLine: (speaker: string, resource: string, why: "overruled" | "unverifiable") => string
export declare const unableLine: (speaker: string, reason: "unknown" | "failed" | "noResource") => string // "I couldn't find that out, Priya."
