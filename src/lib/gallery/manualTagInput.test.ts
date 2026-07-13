import { describe, it, expect } from "vitest";
import { normalizeManualTagName, MANUAL_TAG_NAME_MAX_LENGTH } from "@/lib/gallery/manualTagInput";

describe("normalizeManualTagName", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeManualTagName("  海  ")).toEqual({ ok: true, name: "海" });
  });

  it("rejects an empty string", () => {
    expect(normalizeManualTagName("")).toEqual({ ok: false, error: "name is required" });
  });

  it("rejects a whitespace-only string", () => {
    expect(normalizeManualTagName("   ")).toEqual({ ok: false, error: "name is required" });
  });

  it("accepts exactly 40 characters", () => {
    const name = "a".repeat(MANUAL_TAG_NAME_MAX_LENGTH);
    expect(normalizeManualTagName(name)).toEqual({ ok: true, name });
  });

  it("rejects 41 characters", () => {
    const name = "a".repeat(MANUAL_TAG_NAME_MAX_LENGTH + 1);
    const result = normalizeManualTagName(name);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("40");
  });

  it("accepts a Japanese tag name", () => {
    expect(normalizeManualTagName("夕方")).toEqual({ ok: true, name: "夕方" });
  });

  it("accepts an English tag name", () => {
    expect(normalizeManualTagName("beach")).toEqual({ ok: true, name: "beach" });
  });

  it("rejects a non-string value", () => {
    expect(normalizeManualTagName(123)).toEqual({ ok: false, error: "name must be a string" });
    expect(normalizeManualTagName(undefined)).toEqual({ ok: false, error: "name must be a string" });
    expect(normalizeManualTagName(null)).toEqual({ ok: false, error: "name must be a string" });
  });

  it("does not apply SYNONYM_MAP-style taxonomy normalization (manual input is verbatim)", () => {
    // "海辺" is not in tagTaxonomy's controlled vocabulary/synonym map, but a
    // manually-typed tag must be kept as-is — this helper must never rewrite
    // it to a canonical label like "海".
    expect(normalizeManualTagName("海辺")).toEqual({ ok: true, name: "海辺" });
  });
});
