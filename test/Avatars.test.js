import { describe, expect, it } from "vitest"
import { hash } from "../demo/web/core.js"
import { personOf, PEOPLE } from "../demo/web/person.js"
import { roomOf } from "../demo/web/rooms.js"

describe("soft avatars", () => {
  it("keeps fixed looks for the demo cast", () => {
    expect(PEOPLE.Priya.style).toBe("long")
    expect(personOf("Priya").headset).toBe(true)
    expect(personOf("Sam").glasses).toBe(true)
    expect(personOf("Jordan").style).toBe("beanie")
  })

  it("assigns fixed rooms for the demo cast", () => {
    expect(roomOf("Priya").id).toBe("bookshelf")
    expect(roomOf("Jordan").id).toBe("window")
    expect(roomOf("Sam").id).toBe("kitchen")
    expect(roomOf("Lee").id).toBe("frame")
    expect(roomOf("Mei").id).toBe("whiteboard")
  })

  it("seeds guests deterministically from the name", () => {
    const a = personOf("Alex", 0)
    const b = personOf("Alex", 0)
    expect(a.style).toBe(b.style)
    expect(a.skin).toBe(b.skin)
    expect(hash("Alex")).toBe(hash("Alex"))
  })
})
