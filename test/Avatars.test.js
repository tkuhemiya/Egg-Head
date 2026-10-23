import { describe, expect, it } from "vitest"
import { hash } from "../demo/web/core.js"
import { personOf, PEOPLE } from "../demo/web/person.js"

describe("soft avatars", () => {
  it("keeps fixed looks for the demo cast", () => {
    expect(PEOPLE.Priya.style).toBe("long")
    expect(personOf("Priya").headset).toBe(true)
    expect(personOf("Sam").glasses).toBe(true)
    expect(personOf("Jordan").style).toBe("beanie")
  })

  it("seeds guests deterministically from the name", () => {
    const a = personOf("Alex", 0)
    const b = personOf("Alex", 0)
    expect(a.style).toBe(b.style)
    expect(a.skin).toBe(b.skin)
    expect(hash("Alex")).toBe(hash("Alex"))
  })
})
