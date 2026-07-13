import { describe, it, expect } from "vitest";
import { normalizeBulkPersonName, BULK_PERSON_NAME_MAX_LENGTH } from "@/lib/gallery/bulkPersonInput";

describe("normalizeBulkPersonName", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeBulkPersonName("  凛  ")).toEqual({ ok: true, name: "凛" });
  });

  it("rejects an empty string", () => {
    expect(normalizeBulkPersonName("")).toEqual({ ok: false, error: "name is required" });
  });

  it("rejects a whitespace-only string", () => {
    expect(normalizeBulkPersonName("   ")).toEqual({ ok: false, error: "name is required" });
  });

  it("rejects a non-string value", () => {
    expect(normalizeBulkPersonName(123)).toEqual({ ok: false, error: "name must be a string" });
    expect(normalizeBulkPersonName(undefined)).toEqual({ ok: false, error: "name must be a string" });
    expect(normalizeBulkPersonName(null)).toEqual({ ok: false, error: "name must be a string" });
  });

  it("accepts exactly 40 characters", () => {
    const name = "a".repeat(BULK_PERSON_NAME_MAX_LENGTH);
    expect(normalizeBulkPersonName(name)).toEqual({ ok: true, name });
  });

  it("rejects 41 characters", () => {
    const name = "a".repeat(BULK_PERSON_NAME_MAX_LENGTH + 1);
    const result = normalizeBulkPersonName(name);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("40");
  });

  it("accepts a Japanese name", () => {
    expect(normalizeBulkPersonName("凛")).toEqual({ ok: true, name: "凛" });
  });

  it("accepts an English name", () => {
    expect(normalizeBulkPersonName("Rin")).toEqual({ ok: true, name: "Rin" });
  });
});
