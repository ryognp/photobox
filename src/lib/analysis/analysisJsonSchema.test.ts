import { describe, it, expect } from "vitest";
import { promptAnalysisJsonSchema, USAGE_CATEGORIES } from "@/lib/analysis/analysisSchema";

// Guards that the hand-written Structured Outputs JSON Schema does not drift
// from the zod schema's contract (Phase 10-5D).
describe("promptAnalysisJsonSchema drift guard", () => {
  const s = promptAnalysisJsonSchema.schema;

  it("required keys match the zod output fields", () => {
    expect([...s.required]).toEqual(["tags", "keywords_ja", "keywords_en", "usage_category", "language_detected"]);
  });

  it("usage_category enum matches USAGE_CATEGORIES", () => {
    expect([...s.properties.usage_category.enum]).toEqual([...USAGE_CATEGORIES]);
  });

  it("language_detected enum is ja/en/mixed", () => {
    expect([...s.properties.language_detected.enum]).toEqual(["ja", "en", "mixed"]);
  });

  it("tags maxItems=15, keywords maxItems=20", () => {
    expect(s.properties.tags.maxItems).toBe(15);
    expect(s.properties.keywords_ja.maxItems).toBe(20);
    expect(s.properties.keywords_en.maxItems).toBe(20);
  });

  it("label / keyword maxLength=40", () => {
    expect(s.properties.tags.items.properties.label.maxLength).toBe(40);
    expect(s.properties.keywords_ja.items.maxLength).toBe(40);
    expect(s.properties.keywords_en.items.maxLength).toBe(40);
  });

  it("strict mode with additionalProperties disabled", () => {
    expect(promptAnalysisJsonSchema.strict).toBe(true);
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.tags.items.additionalProperties).toBe(false);
  });

  it("tags.items requires both label and confidence (strict-friendly)", () => {
    expect([...s.properties.tags.items.required]).toEqual(["label", "confidence"]);
  });
});
