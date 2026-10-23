/**
 * Live smoke test: a short scripted call through the Bridge against a real Decider
 * (EGGHEAD_DECIDER_BACKEND, default the free hosted API). Template writer, no AWS.
 *
 *   npm run smoke
 */
import { Console, Effect, Layer, Option, Stream } from "effect"
import { Bridge, type CallInput } from "../src/runtime/Bridge.ts"
import { MockSource } from "../src/domain/Checks.ts"
import * as Decider from "../src/runtime/Decider.ts"
import { Writer } from "../src/domain/Speaker.ts"

const call: ReadonlyArray<CallInput> = [
  { _tag: "Utterance", speaker: "Priya", text: "Checkout is failing for some users. What are we seeing?", silenceS: 0.6 },
  { _tag: "Utterance", speaker: "Sam", text: "The orders DB is fine, it's the API.", silenceS: 0.4 },
  { _tag: "Utterance", speaker: "Priya", text: "Okay, let's focus on the API then.", silenceS: 1.6 },
  { _tag: "Utterance", speaker: "Jordan", text: "We didn't deploy orders-api today.", silenceS: 0.3 },
  { _tag: "Utterance", speaker: "Mei", text: "Hold on, are you sure about that?", silenceS: 0.9 }
]

const program = Effect.gen(function*() {
  const options = yield* Decider.optionsFromEnv
  yield* Console.log(`Decider backend: ${options.url}\n`)
  const bridge = yield* Bridge
  yield* bridge.run(Stream.fromIterable(call)).pipe(
    Stream.runForEach((ev) => {
      const rt = Option.getOrUndefined(ev.route)
      const gate = Option.getOrUndefined(ev.gate)
      const scores = rt ? Object.entries(rt.scores).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(" ") : ""
      return Console.log([
        `${ev.speaker}: ${ev.text}`,
        `  decider ${ev.deciderMs.toFixed(0)} ms · route ${rt?.action} ${Option.getOrElse(rt?.check ?? Option.none(), () => "")} ${scores}`,
        `  verdict ${Option.getOrElse(ev.verdict, () => "-")} · gate ${
          gate ? (gate.speak ? "OPEN" : `blocked by ${Option.getOrNull(gate.blockedBy)}`) : "-"
        }${gate && Option.isSome(gate.repairedBy) ? ` (repaired: ${gate.repairedBy.value})` : ""}`,
        ...Option.match(ev.said, { onNone: () => [], onSome: (s) => [`  >>> EGG HEAD: ${s}`] })
      ].join("\n"))
    })
  )
})

const live = Bridge.layer.pipe(
  Layer.provide(Layer.mergeAll(Decider.layerFromEnv, MockSource.layer(), Writer.template))
)

Effect.runPromise(program.pipe(Effect.provide(live))).catch((e) => {
  console.error(e)
  process.exit(1)
})
