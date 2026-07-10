import { describe, it, expect } from "vitest";
import { normalizeSuggestionLabels, MAX_SUGGESTION_LABELS } from "@/lib/gallery/suggestionFilters";

describe("normalizeSuggestionLabels", () => {
  it("empty for null / undefined / empty string", () => {
    expect(normalizeSuggestionLabels(null)).toEqual([]);
    expect(normalizeSuggestionLabels(undefined)).toEqual([]);
    expect(normalizeSuggestionLabels("")).toEqual([]);
  });

  it("parses comma-separated string", () => {
    expect(normalizeSuggestionLabels("水着,海")).toEqual(["水着", "海"]);
  });

  it("trims and drops empty entries", () => {
    expect(normalizeSuggestionLabels(" 水着 , , 海 ,,")).toEqual(["水着", "海"]);
  });

  it("dedupes", () => {
    expect(normalizeSuggestionLabels("水着,水着,海")).toEqual(["水着", "海"]);
  });

  it("accepts an array input too (client filters)", () => {
    expect(normalizeSuggestionLabels([" 水着 ", "海", "海"])).toEqual(["水着", "海"]);
  });

  it("caps at MAX_SUGGESTION_LABELS", () => {
    const many = Array.from({ length: MAX_SUGGESTION_LABELS + 5 }, (_, i) => `l${i}`);
    expect(normalizeSuggestionLabels(many)).toHaveLength(MAX_SUGGESTION_LABELS);
  });
});
