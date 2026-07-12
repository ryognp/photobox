import { describe, it, expect } from "vitest";
import {
  validateChanges,
  truncateVariationInput,
  sanitizeVariationError,
} from "@/lib/promptVariation/variationCore";

describe("validateChanges", () => {
  it("accepts a valid non-empty enum array", () => {
    const r = validateChanges(["pose", "outfit"]);
    expect(r).toEqual({ ok: true, changes: ["pose", "outfit"] });
  });

  it("accepts all 5 changes", () => {
    const all = ["pose", "outfit", "expression", "place", "mood_time"];
    const r = validateChanges(all);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.changes).toEqual(all);
  });

  it("rejects a non-array", () => {
    expect(validateChanges("pose").ok).toBe(false);
    expect(validateChanges(undefined).ok).toBe(false);
    expect(validateChanges(null).ok).toBe(false);
    expect(validateChanges({}).ok).toBe(false);
  });

  it("rejects an empty array", () => {
    const r = validateChanges([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/empty/);
  });

  it("rejects more than 5 items", () => {
    const r = validateChanges(["pose", "outfit", "expression", "place", "mood_time", "pose"]);
    expect(r.ok).toBe(false);
  });

  it("rejects an unknown change", () => {
    const r = validateChanges(["pose", "hairstyle"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown change: hairstyle/);
  });

  it("rejects non-string items", () => {
    expect(validateChanges(["pose", 3]).ok).toBe(false);
  });

  it("rejects duplicates", () => {
    const r = validateChanges(["pose", "pose"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/duplicate change: pose/);
  });
});

describe("truncateVariationInput", () => {
  it("returns text unchanged when within limit", () => {
    expect(truncateVariationInput("short", 8000)).toEqual({ text: "short", truncated: false });
  });
  it("truncates and appends a marker when over limit", () => {
    const r = truncateVariationInput("a".repeat(100), 10);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith("a".repeat(10))).toBe(true);
    expect(r.text).toContain("切り詰め");
  });
  it("boundary: exactly at limit is not truncated", () => {
    expect(truncateVariationInput("abcde", 5)).toEqual({ text: "abcde", truncated: false });
  });
});

describe("sanitizeVariationError", () => {
  it("redacts an API key and caps length", () => {
    const out = sanitizeVariationError(new Error("boom sk-secretKEY123_-"));
    expect(out).not.toContain("sk-secretKEY123_-");
    expect(out).toContain("[REDACTED_API_KEY]");
  });
  it("handles non-Error inputs", () => {
    expect(sanitizeVariationError("plain string")).toBe("plain string");
    expect(sanitizeVariationError(null)).toBe("prompt variation failed");
  });
});
