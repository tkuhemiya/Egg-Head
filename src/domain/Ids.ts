/** Ids and small closed vocabularies shared by every module. A leaf: imports nothing from src/. */
import { Schema } from "effect"

export const ClaimId = Schema.String.pipe(Schema.brand("ClaimId"))
export type ClaimId = typeof ClaimId.Type
export const JobId = Schema.String.pipe(Schema.brand("JobId"))
export type JobId = typeof JobId.Type
export const SpeechId = Schema.String.pipe(Schema.brand("SpeechId"))
export type SpeechId = typeof SpeechId.Type
export const RequestId = Schema.Int.pipe(Schema.brand("RequestId"))
export type RequestId = typeof RequestId.Type

export const claimId = (turn: number, check: string, resource: string): ClaimId =>
  `${turn}:${check}:${resource}` as ClaimId
export const jobId = (epoch: string, n: number): JobId => `${epoch}/${n}` as JobId
export const speechId = (epoch: string, n: number): SpeechId => `${epoch}/s${n}` as SpeechId
export const requestId = (n: number): RequestId => n as RequestId
export const jobNumber = (id: JobId): number => Number(String(id).split("/")[1] ?? 0)

export const Basis = Schema.Literals(["confirmed", "fastCheck"])
export type Basis = typeof Basis.Type

export const Certainty = Schema.Literals(["firm", "tentative"])
export type Certainty = typeof Certainty.Type

export const Voice = Schema.Literals(["firm", "doubleChecking", "couldNotConfirm"])
export type Voice = typeof Voice.Type
export const certaintyOf = (v: Voice): Certainty => (v === "firm" ? "firm" : "tentative")

export const RepairedBy = Schema.Literals(["ledger", "keyword", "decider"])
export type RepairedBy = typeof RepairedBy.Type
