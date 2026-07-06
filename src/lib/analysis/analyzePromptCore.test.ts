import { describe, it, expect } from "vitest";
import {
  analyzePromptCore,
  buildAnalysisText,
  computePromptHash,
} from "@/lib/analysis/analyzePromptCore";
import { createMockProvider, createThrowingProvider } from "@/lib/analysis/mockProvider";
import { isAttributeTerm, filterAttributeTerms } from "@/lib/analysis/analysisSchema";

const DEPS = (output?: unknown) => ({
  provider: createMockProvider(output),
  schemaVersion: "prompt-v1",
});

describe("buildAnalysisText", () => {
  it("empty when both null/blank", () => {
    expect(buildAnalysisText({ currentBody: null, notes: null })).toBe("");
    expect(buildAnalysisText({ currentBody: "   ", notes: "\n\t" })).toBe("");
  });
  it("currentBody only", () => {
    expect(buildAnalysisText({ currentBody: "a cat", notes: null })).toBe("a cat");
  });
  it("notes only", () => {
    expect(buildAnalysisText({ currentBody: null, notes: "猫" })).toBe("猫");
  });
  it("both joined + whitespace normalized", () => {
    expect(buildAnalysisText({ currentBody: "a   cat", notes: "  猫 " })).toBe("a cat 猫");
  });
});

describe("computePromptHash", () => {
  it("stable for same input, differs for different input", () => {
    expect(computePromptHash("a cat")).toBe(computePromptHash("a cat"));
    expect(computePromptHash("a cat")).not.toBe(computePromptHash("a dog"));
  });
});

describe("analyzePromptCore — SKIPPED", () => {
  it("no prompt text → SKIPPED_NO_PROMPT, provider not called", async () => {
    let called = false;
    const provider = { modelId: "mock", analyze: async () => { called = true; return {}; } };
    const r = await analyzePromptCore({ currentBody: "", notes: null }, { provider, schemaVersion: "prompt-v1" });
    expect(r.status).toBe("SKIPPED_NO_PROMPT");
    if (r.status === "SKIPPED_NO_PROMPT") expect(r.promptHash).toBeNull();
    expect(called).toBe(false);
  });
});

describe("analyzePromptCore — DONE", () => {
  it("valid output → DONE with normalized fields", async () => {
    const r = await analyzePromptCore(
      { currentBody: "a serene mountain lake at dawn", notes: null },
      DEPS({
        tags: [{ label: "landscape", confidence: 0.9 }, { label: "mountain" }],
        keywords_ja: ["山", "湖"],
        keywords_en: ["mountain", "lake"],
        usage_category: "scene_reference",
        language_detected: "en",
      }),
    );
    expect(r.status).toBe("DONE");
    if (r.status === "DONE") {
      expect(r.tags).toEqual([{ label: "landscape", confidence: 0.9 }, { label: "mountain" }]);
      expect(r.keywordsJa).toEqual(["山", "湖"]);
      expect(r.keywordsEn).toEqual(["mountain", "lake"]);
      expect(r.usageCategory).toBe("scene_reference");
      expect(r.languageDetected).toBe("en");
      expect(r.promptHash).toHaveLength(64);
    }
  });

  it("dedupes tag labels case-insensitively (first occurrence wins)", async () => {
    const r = await analyzePromptCore(
      { currentBody: "x", notes: null },
      DEPS({
        tags: [
          { label: "Landscape", confidence: 0.9 },
          { label: "landscape", confidence: 0.1 },
          { label: " landscape ", confidence: 0.2 },
          { label: "mountain" },
        ],
        keywords_ja: [],
        keywords_en: [],
        usage_category: "scene_reference",
        language_detected: "en",
      }),
    );
    expect(r.status).toBe("DONE");
    if (r.status === "DONE") {
      expect(r.tags).toEqual([{ label: "Landscape", confidence: 0.9 }, { label: "mountain" }]);
    }
  });

  it("unknown usage_category coerced to 'other'", async () => {
    const r = await analyzePromptCore(
      { currentBody: "x", notes: null },
      DEPS({ tags: [], keywords_ja: [], keywords_en: [], usage_category: "banana", language_detected: "en" }),
    );
    expect(r.status === "DONE" && r.usageCategory).toBe("other");
  });

  it("strips person-attribute terms from tags & keywords (defense-in-depth)", async () => {
    const r = await analyzePromptCore(
      { currentBody: "portrait", notes: null },
      DEPS({
        tags: [{ label: "portrait" }, { label: "female" }, { label: "asian" }],
        keywords_ja: ["女性", "風景"],
        keywords_en: ["woman", "sunset"],
        usage_category: "portrait",
        language_detected: "mixed",
      }),
    );
    expect(r.status).toBe("DONE");
    if (r.status === "DONE") {
      expect(r.tags.map((t) => t.label)).toEqual(["portrait"]);
      expect(r.keywordsJa).toEqual(["風景"]);
      expect(r.keywordsEn).toEqual(["sunset"]);
    }
  });
});

describe("analyzePromptCore — FAILED", () => {
  it("provider throws → FAILED", async () => {
    const r = await analyzePromptCore(
      { currentBody: "x", notes: null },
      { provider: createThrowingProvider("boom"), schemaVersion: "prompt-v1" },
    );
    expect(r.status).toBe("FAILED");
    if (r.status === "FAILED") {
      expect(r.error).toBe("boom");
      expect(r.promptHash).toHaveLength(64);
    }
  });

  it("schema-invalid output → FAILED with raw retained", async () => {
    const r = await analyzePromptCore(
      { currentBody: "x", notes: null },
      DEPS({ tags: "not-an-array", keywords_ja: [], keywords_en: [] }),
    );
    expect(r.status).toBe("FAILED");
    if (r.status === "FAILED") {
      expect(r.error).toBe("schema_validation_failed");
      expect(r.raw).toBeDefined();
    }
  });
});

describe("attribute denylist", () => {
  it("flags attribute terms (EN + JA)", () => {
    for (const t of ["female", "Asian", "12 years old", "gender", "女性", "人種", "本名"]) {
      expect(isAttributeTerm(t)).toBe(true);
    }
  });
  it("does not flag benign terms", () => {
    for (const t of ["portrait", "landscape", "sunset", "猫", "風景", "product"]) {
      expect(isAttributeTerm(t)).toBe(false);
    }
  });
  it("whole-word match avoids false positives on substrings", () => {
    // "management" contains "man" but should NOT be flagged
    expect(isAttributeTerm("management")).toBe(false);
    expect(filterAttributeTerms(["management", "woman"])).toEqual(["management"]);
  });
});
