import { describe, it, expect } from "vitest"
import {
  getFavoritePromptsKey,
  readFavoritePrompts,
  addFavoritePrompt,
  removeFavoritePrompt,
  clearFavoritePrompts,
  makeFavoritePromptItem,
  formatFavoritePromptKind,
  type FavoritePromptItem,
  type StorageLike,
} from "@/lib/gallery/favoritePrompts"

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

describe("getFavoritePromptsKey", () => {
  it("is a single global, versioned key", () => {
    expect(getFavoritePromptsKey()).toBe("photobox:favorite-prompts:v1")
  })
})

describe("readFavoritePrompts", () => {
  it("returns [] when storage is undefined", () => {
    expect(readFavoritePrompts()).toEqual([])
  })

  it("returns [] when key is absent", () => {
    expect(readFavoritePrompts(memoryStorage())).toEqual([])
  })

  it("returns [] on invalid JSON", () => {
    const storage = memoryStorage({ [getFavoritePromptsKey()]: "not json{{{" })
    expect(readFavoritePrompts(storage)).toEqual([])
  })

  it("returns [] when stored value is valid JSON but not an array", () => {
    const storage = memoryStorage({ [getFavoritePromptsKey()]: JSON.stringify({ not: "an array" }) })
    expect(readFavoritePrompts(storage)).toEqual([])
  })

  it("filters out malformed entries (missing id/text)", () => {
    const storage = memoryStorage({
      [getFavoritePromptsKey()]: JSON.stringify([
        { id: "a", text: "ok", sourceImageId: "img-1", sourceImageName: "x.jpg", kind: "current_prompt", createdAt: "x" },
        { text: "missing id" },
        null,
        "not an object",
      ]),
    })
    const items = readFavoritePrompts(storage)
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe("a")
  })

  it("does not throw when storage.getItem throws", () => {
    expect(readFavoritePrompts(throwingStorage())).toEqual([])
  })
})

describe("addFavoritePrompt", () => {
  const makeItem = (text: string, kind: FavoritePromptItem["kind"] = "current_prompt"): FavoritePromptItem =>
    makeFavoritePromptItem(
      { sourceImageId: "img-1", sourceImageName: "x.jpg", text, kind },
      new Date("2026-07-12T00:00:00.000Z"),
    )

  it("stores newest first", () => {
    const storage = memoryStorage()
    addFavoritePrompt(makeItem("first"), storage)
    const after = addFavoritePrompt(makeItem("second"), storage)
    expect(after.map((i) => i.text)).toEqual(["second", "first"])
  })

  it("caps at 50 items, dropping the oldest", () => {
    const storage = memoryStorage()
    let latest: FavoritePromptItem[] = []
    for (let i = 0; i < 55; i++) {
      latest = addFavoritePrompt(makeItem(`text-${i}`), storage)
    }
    expect(latest).toHaveLength(50)
    expect(latest[0].text).toBe("text-54")
    expect(latest[latest.length - 1].text).toBe("text-5")
  })

  it("moves an identical text to the front instead of duplicating", () => {
    const storage = memoryStorage()
    addFavoritePrompt(makeItem("a"), storage)
    addFavoritePrompt(makeItem("b"), storage)
    const after = addFavoritePrompt(makeItem("a"), storage)
    expect(after.map((i) => i.text)).toEqual(["a", "b"])
    expect(after).toHaveLength(2)
  })

  it("does not throw when storage throws; still returns the computed list", () => {
    const storage = throwingStorage()
    const item = makeItem("x")
    expect(() => addFavoritePrompt(item, storage)).not.toThrow()
    expect(addFavoritePrompt(item, storage)).toEqual([item])
  })

  it("works without a storage arg (returns computed list, persists nothing)", () => {
    const item = makeItem("x")
    expect(addFavoritePrompt(item)).toEqual([item])
  })
})

describe("removeFavoritePrompt", () => {
  it("removes only the matching id", () => {
    const storage = memoryStorage()
    const a = makeFavoritePromptItem({ sourceImageId: "img-1", sourceImageName: "x.jpg", text: "a", kind: "current_prompt" })
    const b = makeFavoritePromptItem({ sourceImageId: "img-1", sourceImageName: "x.jpg", text: "b", kind: "current_prompt" })
    addFavoritePrompt(a, storage)
    addFavoritePrompt(b, storage)
    const after = removeFavoritePrompt(a.id, storage)
    expect(after.map((i) => i.id)).toEqual([b.id])
  })

  it("no-ops when id not found", () => {
    const storage = memoryStorage()
    const a = makeFavoritePromptItem({ sourceImageId: "img-1", sourceImageName: "x.jpg", text: "a", kind: "current_prompt" })
    addFavoritePrompt(a, storage)
    expect(removeFavoritePrompt("nonexistent", storage)).toHaveLength(1)
  })
})

describe("clearFavoritePrompts", () => {
  it("removes all favorites", () => {
    const storage = memoryStorage()
    addFavoritePrompt(
      makeFavoritePromptItem({ sourceImageId: "img-1", sourceImageName: "x.jpg", text: "a", kind: "current_prompt" }),
      storage,
    )
    clearFavoritePrompts(storage)
    expect(readFavoritePrompts(storage)).toEqual([])
  })

  it("does not throw when storage.removeItem throws", () => {
    expect(() => clearFavoritePrompts(throwingStorage())).not.toThrow()
  })

  it("no-ops when storage is undefined", () => {
    expect(() => clearFavoritePrompts()).not.toThrow()
  })
})

describe("makeFavoritePromptItem", () => {
  it("has id/sourceImageId/sourceImageName/text/kind/createdAt", () => {
    const item = makeFavoritePromptItem(
      { sourceImageId: "img-1", sourceImageName: "x.jpg", text: "hello", kind: "current_prompt" },
      new Date("2026-07-12T00:00:00.000Z"),
    )
    expect(item.sourceImageId).toBe("img-1")
    expect(item.sourceImageName).toBe("x.jpg")
    expect(item.text).toBe("hello")
    expect(item.kind).toBe("current_prompt")
    expect(item.createdAt).toBe("2026-07-12T00:00:00.000Z")
    expect(typeof item.id).toBe("string")
    expect(item.id.length).toBeGreaterThan(0)
    expect(item.changes).toBeUndefined()
  })

  it("includes changes when kind is variation", () => {
    const item = makeFavoritePromptItem({
      sourceImageId: "img-1",
      sourceImageName: "x.jpg",
      text: "hello",
      kind: "variation",
      changes: ["pose", "outfit"],
    })
    expect(item.kind).toBe("variation")
    expect(item.changes).toEqual(["pose", "outfit"])
  })

  it("ids are unique across calls even with the same explicit `now`", () => {
    const now = new Date("2026-07-12T00:00:00.000Z")
    const a = makeFavoritePromptItem({ sourceImageId: "img-1", sourceImageName: "x.jpg", text: "x", kind: "current_prompt" }, now)
    const b = makeFavoritePromptItem({ sourceImageId: "img-1", sourceImageName: "x.jpg", text: "x", kind: "current_prompt" }, now)
    expect(a.id).not.toBe(b.id)
  })
})

describe("formatFavoritePromptKind", () => {
  it("renders JA labels", () => {
    expect(formatFavoritePromptKind("current_prompt")).toBe("現在のPrompt")
    expect(formatFavoritePromptKind("variation")).toBe("生成案")
  })
})
