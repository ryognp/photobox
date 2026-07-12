import { describe, it, expect } from "vitest"
import {
  getPromptVariationHistoryKey,
  readPromptVariationHistory,
  addPromptVariationHistoryItem,
  removePromptVariationHistoryItem,
  clearPromptVariationHistory,
  formatVariationChanges,
  makePromptVariationHistoryItem,
  type PromptVariationHistoryItem,
  type StorageLike,
} from "@/lib/gallery/promptVariationHistory"
import type { VariationChange } from "@/lib/gallery/imagesClient"

function memoryStorage(initial: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v) },
    removeItem: (k) => { map.delete(k) },
  }
}

function throwingStorage(): StorageLike {
  return {
    getItem: () => { throw new Error("blocked") },
    setItem: () => { throw new Error("blocked") },
    removeItem: () => { throw new Error("blocked") },
  }
}

describe("getPromptVariationHistoryKey", () => {
  it("is namespaced, versioned, and per-image", () => {
    expect(getPromptVariationHistoryKey("img-1")).toBe("photobox:prompt-variation-history:v1:img-1")
    expect(getPromptVariationHistoryKey("img-2")).not.toBe(getPromptVariationHistoryKey("img-1"))
  })
})

describe("readPromptVariationHistory", () => {
  it("returns [] when storage is undefined", () => {
    expect(readPromptVariationHistory("img-1")).toEqual([])
  })

  it("returns [] when key is absent", () => {
    expect(readPromptVariationHistory("img-1", memoryStorage())).toEqual([])
  })

  it("returns [] on invalid JSON", () => {
    const storage = memoryStorage({ [getPromptVariationHistoryKey("img-1")]: "not json{{{" })
    expect(readPromptVariationHistory("img-1", storage)).toEqual([])
  })

  it("returns [] when stored value is valid JSON but not an array", () => {
    const storage = memoryStorage({ [getPromptVariationHistoryKey("img-1")]: JSON.stringify({ not: "an array" }) })
    expect(readPromptVariationHistory("img-1", storage)).toEqual([])
  })

  it("filters out malformed entries (missing id/text)", () => {
    const storage = memoryStorage({
      [getPromptVariationHistoryKey("img-1")]: JSON.stringify([
        { id: "a", text: "ok", changes: [], imageId: "img-1", createdAt: "x" },
        { text: "missing id" },
        null,
        "not an object",
      ]),
    })
    const items = readPromptVariationHistory("img-1", storage)
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe("a")
  })

  it("does not throw when storage.getItem throws", () => {
    expect(readPromptVariationHistory("img-1", throwingStorage())).toEqual([])
  })
})

describe("addPromptVariationHistoryItem", () => {
  const makeItem = (text: string, changes: VariationChange[] = ["pose"]): PromptVariationHistoryItem =>
    makePromptVariationHistoryItem("img-1", text, changes, new Date("2026-07-12T00:00:00.000Z"))

  it("stores newest first", () => {
    const storage = memoryStorage()
    addPromptVariationHistoryItem("img-1", makeItem("first"), storage)
    const after = addPromptVariationHistoryItem("img-1", makeItem("second"), storage)
    expect(after.map((i) => i.text)).toEqual(["second", "first"])
  })

  it("caps at 5 items, dropping the oldest", () => {
    const storage = memoryStorage()
    let latest: PromptVariationHistoryItem[] = []
    for (let i = 0; i < 7; i++) {
      latest = addPromptVariationHistoryItem("img-1", makeItem(`text-${i}`), storage)
    }
    expect(latest).toHaveLength(5)
    expect(latest.map((i) => i.text)).toEqual(["text-6", "text-5", "text-4", "text-3", "text-2"])
  })

  it("moves an identical text+changes item to the front instead of duplicating", () => {
    const storage = memoryStorage()
    addPromptVariationHistoryItem("img-1", makeItem("a", ["pose"]), storage)
    addPromptVariationHistoryItem("img-1", makeItem("b", ["outfit"]), storage)
    const after = addPromptVariationHistoryItem("img-1", makeItem("a", ["pose"]), storage)
    expect(after.map((i) => i.text)).toEqual(["a", "b"])
  })

  it("does not dedupe when changes differ even if text matches", () => {
    const storage = memoryStorage()
    addPromptVariationHistoryItem("img-1", makeItem("a", ["pose"]), storage)
    const after = addPromptVariationHistoryItem("img-1", makeItem("a", ["outfit"]), storage)
    expect(after).toHaveLength(2)
  })

  it("is scoped per imageId", () => {
    const storage = memoryStorage()
    addPromptVariationHistoryItem("img-1", makeItem("only-in-1"), storage)
    expect(readPromptVariationHistory("img-2", storage)).toEqual([])
    expect(readPromptVariationHistory("img-1", storage)).toHaveLength(1)
  })

  it("does not throw when storage throws; still returns the computed list", () => {
    const storage = throwingStorage()
    const item = makeItem("x")
    expect(() => addPromptVariationHistoryItem("img-1", item, storage)).not.toThrow()
    expect(addPromptVariationHistoryItem("img-1", item, storage)).toEqual([item])
  })

  it("works without a storage arg (returns computed list, persists nothing)", () => {
    const item = makeItem("x")
    expect(addPromptVariationHistoryItem("img-1", item)).toEqual([item])
  })
})

describe("removePromptVariationHistoryItem", () => {
  it("removes only the matching id", () => {
    const storage = memoryStorage()
    const a = makePromptVariationHistoryItem("img-1", "a", ["pose"])
    const b = makePromptVariationHistoryItem("img-1", "b", ["outfit"])
    addPromptVariationHistoryItem("img-1", a, storage)
    addPromptVariationHistoryItem("img-1", b, storage)
    const after = removePromptVariationHistoryItem("img-1", a.id, storage)
    expect(after.map((i) => i.id)).toEqual([b.id])
  })

  it("no-ops when id not found", () => {
    const storage = memoryStorage()
    const a = makePromptVariationHistoryItem("img-1", "a", ["pose"])
    addPromptVariationHistoryItem("img-1", a, storage)
    expect(removePromptVariationHistoryItem("img-1", "nonexistent", storage)).toHaveLength(1)
  })
})

describe("clearPromptVariationHistory", () => {
  it("removes all history for the image", () => {
    const storage = memoryStorage()
    addPromptVariationHistoryItem("img-1", makePromptVariationHistoryItem("img-1", "a", ["pose"]), storage)
    clearPromptVariationHistory("img-1", storage)
    expect(readPromptVariationHistory("img-1", storage)).toEqual([])
  })

  it("does not throw when storage.removeItem throws", () => {
    expect(() => clearPromptVariationHistory("img-1", throwingStorage())).not.toThrow()
  })

  it("no-ops when storage is undefined", () => {
    expect(() => clearPromptVariationHistory("img-1")).not.toThrow()
  })
})

describe("formatVariationChanges", () => {
  it("renders JA labels with the trailing 'を変える' dropped", () => {
    expect(formatVariationChanges(["pose"])).toBe("ポーズ")
    expect(formatVariationChanges(["pose", "outfit"])).toBe("ポーズ, 服装")
  })

  it("covers all 5 dimensions", () => {
    expect(formatVariationChanges(["pose", "outfit", "expression", "place", "mood_time"])).toBe(
      "ポーズ, 服装, 表情, 場所, 雰囲気・時間帯",
    )
  })

  it("empty changes → empty string", () => {
    expect(formatVariationChanges([])).toBe("")
  })
})

describe("makePromptVariationHistoryItem", () => {
  it("has id, imageId, text, changes, createdAt", () => {
    const item = makePromptVariationHistoryItem("img-1", "hello", ["place"], new Date("2026-07-12T00:00:00.000Z"))
    expect(item.imageId).toBe("img-1")
    expect(item.text).toBe("hello")
    expect(item.changes).toEqual(["place"])
    expect(item.createdAt).toBe("2026-07-12T00:00:00.000Z")
    expect(typeof item.id).toBe("string")
    expect(item.id.length).toBeGreaterThan(0)
  })

  it("ids are unique across calls even with the same explicit `now`", () => {
    const now = new Date("2026-07-12T00:00:00.000Z")
    const a = makePromptVariationHistoryItem("img-1", "x", ["pose"], now)
    const b = makePromptVariationHistoryItem("img-1", "x", ["pose"], now)
    expect(a.id).not.toBe(b.id)
  })
})
