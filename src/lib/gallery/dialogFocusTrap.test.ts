import { describe, expect, it } from "vitest"
import { getFocusTrapFocusTarget } from "./dialogFocusTrap"

describe("getFocusTrapFocusTarget", () => {
  it("returns none when there are no focusable elements", () => {
    expect(getFocusTrapFocusTarget([], "anything", false)).toBe("none")
    expect(getFocusTrapFocusTarget([], "anything", true)).toBe("none")
  })

  it("wraps to last on Shift+Tab from the first focusable", () => {
    const focusables = ["a", "b", "c"]
    expect(getFocusTrapFocusTarget(focusables, "a", true)).toBe("last")
  })

  it("wraps to first on Tab from the last focusable", () => {
    const focusables = ["a", "b", "c"]
    expect(getFocusTrapFocusTarget(focusables, "c", false)).toBe("first")
  })

  it("does nothing when active element is in the middle", () => {
    const focusables = ["a", "b", "c"]
    expect(getFocusTrapFocusTarget(focusables, "b", false)).toBe("none")
    expect(getFocusTrapFocusTarget(focusables, "b", true)).toBe("none")
  })

  it("sends focus to first on Tab when active element is outside focusables (e.g. the tabIndex=-1 container)", () => {
    const focusables = ["a", "b", "c"]
    expect(getFocusTrapFocusTarget(focusables, "container", false)).toBe("first")
  })

  it("sends focus to last on Shift+Tab when active element is outside focusables (e.g. the tabIndex=-1 container)", () => {
    const focusables = ["a", "b", "c"]
    expect(getFocusTrapFocusTarget(focusables, "container", true)).toBe("last")
  })
})
