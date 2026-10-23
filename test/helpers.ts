// The scripted Decider lives in src/Hints.ts (demo rehearsals and the offline harness use it
// too). Re-exported so the existing tests, test/Parity.test.ts among them, keep their imports.
export { answerLine, choiceOver, finFor, latestOf, type Line, noul, scripted } from "../src/Hints.ts"
