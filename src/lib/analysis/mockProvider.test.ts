import { describe, it, expect } from "vitest";
import { createMockProvider, createThrowingProvider } from "@/lib/analysis/mockProvider";
import { filterAttributeTerms } from "@/lib/analysis/analysisSchema";

describe("createMockProvider — default output (Phase 10-5C: Japanese tags)", () => {
  it("returns Japanese tag labels for known English keywords, never the raw English word", async () => {
    const provider = createMockProvider();
    const result = (await provider.analyze("portrait cafe dog")) as {
      tags: { label: string }[];
      keywords_ja: string[];
      keywords_en: string[];
      language_detected: string;
    };
    const labels = result.tags.map((t) => t.label);
    expect(labels).toContain("ポートレート");
    expect(labels).toContain("カフェ");
    expect(labels).toContain("犬");
    expect(labels).not.toContain("portrait");
    expect(labels).not.toContain("cafe");
    expect(labels).not.toContain("dog");
    expect(result.keywords_en).toEqual([]);
    expect(result.language_detected).toBe("ja");
  });

  it("emits NO tags for unmapped words (Phase 10-5E: filler fallback removed)", async () => {
    const provider = createMockProvider();
    const result = (await provider.analyze("xyzzy quux")) as { tags: { label: string }[] };
    expect(result.tags).toEqual([]);
  });

  it("mapped Japanese tags are never dropped by the attribute denylist", async () => {
    const provider = createMockProvider();
    const result = (await provider.analyze(
      "portrait cafe dog cat food product landscape",
    )) as { tags: { label: string }[] };
    const labels = result.tags.map((t) => t.label);
    expect(labels.length).toBeGreaterThan(0);
    expect(filterAttributeTerms(labels)).toEqual(labels);
  });

  it("explicit output overrides the default (existing callers unaffected)", async () => {
    const provider = createMockProvider({ tags: [{ label: "custom" }], keywords_ja: [], keywords_en: [] });
    const result = await provider.analyze("anything");
    expect(result).toEqual({ tags: [{ label: "custom" }], keywords_ja: [], keywords_en: [] });
  });
});

describe("createThrowingProvider", () => {
  it("always rejects with the given message", async () => {
    const provider = createThrowingProvider("boom");
    await expect(provider.analyze("x")).rejects.toThrow("boom");
  });
});
