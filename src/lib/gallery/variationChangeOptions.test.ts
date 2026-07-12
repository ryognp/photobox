import { describe, it, expect } from "vitest"
import { VARIATION_CHANGE_OPTIONS, toggleVariationChange } from "@/lib/gallery/variationChangeOptions"
import type { VariationChange } from "@/lib/gallery/imagesClient"

describe("VARIATION_CHANGE_OPTIONS", () => {
  it("has exactly the 5 confirmed dimensions, in order, with JA labels", () => {
    expect(VARIATION_CHANGE_OPTIONS).toEqual([
      { value: "pose", label: "ポーズを変える" },
      { value: "outfit", label: "服装を変える" },
      { value: "expression", label: "表情を変える" },
      { value: "place", label: "場所を変える" },
      { value: "mood_time", label: "雰囲気・時間帯を変える" },
    ])
  })

  it("values are unique", () => {
    const values = VARIATION_CHANGE_OPTIONS.map((o) => o.value)
    expect(new Set(values).size).toBe(values.length)
  })
})

describe("toggleVariationChange", () => {
  it("adds a change not yet selected", () => {
    expect(toggleVariationChange([], "pose")).toEqual(["pose"])
    expect(toggleVariationChange(["pose"], "outfit")).toEqual(["pose", "outfit"])
  })

  it("removes a change already selected", () => {
    expect(toggleVariationChange(["pose", "outfit"], "pose")).toEqual(["outfit"])
  })

  it("removing the only selected item yields an empty array", () => {
    expect(toggleVariationChange(["pose"], "pose")).toEqual([])
  })

  it("does not mutate the input array", () => {
    const input: VariationChange[] = ["pose"]
    toggleVariationChange(input, "outfit")
    expect(input).toEqual(["pose"])
  })
})
