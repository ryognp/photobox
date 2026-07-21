import { describe, expect, it } from "vitest"
import { shouldIgnoreArrowNav } from "./keyboardNav"

describe("shouldIgnoreArrowNav", () => {
  it("ignores textarea", () => {
    expect(shouldIgnoreArrowNav("textarea")).toBe(true)
  })

  it("ignores input", () => {
    expect(shouldIgnoreArrowNav("input")).toBe(true)
  })

  it("ignores select", () => {
    expect(shouldIgnoreArrowNav("select")).toBe(true)
  })

  it("ignores contenteditable regardless of tag", () => {
    expect(shouldIgnoreArrowNav("div", true)).toBe(true)
  })

  it("does not ignore button", () => {
    expect(shouldIgnoreArrowNav("button")).toBe(false)
  })

  it("does not ignore div", () => {
    expect(shouldIgnoreArrowNav("div")).toBe(false)
  })

  it("does not ignore undefined/null tag names", () => {
    expect(shouldIgnoreArrowNav(undefined)).toBe(false)
    expect(shouldIgnoreArrowNav(null)).toBe(false)
  })

  it("is case-insensitive", () => {
    expect(shouldIgnoreArrowNav("TEXTAREA")).toBe(true)
    expect(shouldIgnoreArrowNav("SELECT")).toBe(true)
    expect(shouldIgnoreArrowNav("BUTTON")).toBe(false)
  })
})
