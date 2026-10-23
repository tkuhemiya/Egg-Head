// DELTA to demo/server.ts: nothing about speaking. Job identity is the Bridge's JobId; /agent/report is
// keyed by it (b629bba already keys reports); a report for a job the Bridge finished (Cancelled/TimedOut)
// is dropped by Jobs.finish's idempotence, so a stale report cannot answer a new job.
// A run builds `Bridge.layer` with Policy from the optional Investigator layer; `state.tasks` becomes
// `Object.keys(state.jobs.table).length`.
export {}
