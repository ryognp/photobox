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

  // Phase 10-5C: effectiveJapaneseBody priority
  it("effectiveJapaneseBody takes priority over currentBody when present", () => {
    expect(
      buildAnalysisText({
        currentBody: "a cute cat",
        notes: null,
        effectiveJapaneseBody: "可愛い猫",
      }),
    ).toBe("可愛い猫");
  });

  it("effectiveJapaneseBody + notes are joined (currentBody dropped)", () => {
    expect(
      buildAnalysisText({
        currentBody: "a cute cat",
        notes: "備考",
        effectiveJapaneseBody: "可愛い猫",
      }),
    ).toBe("可愛い猫 備考");
  });

  it("falls back to currentBody + notes when effectiveJapaneseBody is null/absent", () => {
    expect(
      buildAnalysisText({ currentBody: "a cute cat", notes: "note", effectiveJapaneseBody: null }),
    ).toBe("a cute cat note");
    expect(buildAnalysisText({ currentBody: "a cute cat", notes: "note" })).toBe("a cute cat note");
  });

  it("falls back to currentBody when effectiveJapaneseBody is an empty/blank string", () => {
    expect(
      buildAnalysisText({ currentBody: "a cute cat", notes: null, effectiveJapaneseBody: "   " }),
    ).toBe("a cute cat");
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
  it("valid output → DONE with normalized fields (Phase 10-5E: controlled-vocab tags)", async () => {
    const r = await analyzePromptCore(
      { currentBody: "a serene sea at dawn", notes: null },
      DEPS({
        tags: [{ label: "海", confidence: 0.9 }, { label: "風景" }],
        keywords_ja: ["山", "湖"],
        keywords_en: ["mountain", "lake"],
        usage_category: "scene_reference",
        language_detected: "en",
      }),
    );
    expect(r.status).toBe("DONE");
    if (r.status === "DONE") {
      // place (海) sorts before subject (風景) by category priority.
      expect(r.tags).toEqual([{ label: "海", confidence: 0.9 }, { label: "風景" }]);
      expect(r.keywordsJa).toEqual(["山", "湖"]);
      expect(r.keywordsEn).toEqual(["mountain", "lake"]);
      expect(r.usageCategory).toBe("scene_reference");
      expect(r.languageDetected).toBe("en");
      expect(r.promptHash).toHaveLength(64);
    }
  });

  it("dedupes tags via synonym normalization (first occurrence wins, Phase 10-5E)", async () => {
    const r = await analyzePromptCore(
      { currentBody: "x", notes: null },
      DEPS({
        tags: [
          { label: "海辺", confidence: 0.9 },
          { label: "海", confidence: 0.1 },
          { label: " 海岸 ", confidence: 0.2 },
          { label: "風景" },
        ],
        keywords_ja: [],
        keywords_en: [],
        usage_category: "scene_reference",
        language_detected: "en",
      }),
    );
    expect(r.status).toBe("DONE");
    if (r.status === "DONE") {
      // 海辺/海/海岸 all normalize to 海; first (confidence 0.9) wins.
      expect(r.tags).toEqual([{ label: "海", confidence: 0.9 }, { label: "風景" }]);
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
        tags: [{ label: "全身" }, { label: "female" }, { label: "asian" }],
        keywords_ja: ["女性", "風景"],
        keywords_en: ["woman", "sunset"],
        usage_category: "portrait",
        language_detected: "mixed",
      }),
    );
    expect(r.status).toBe("DONE");
    if (r.status === "DONE") {
      // female/asian are removed by the attribute denylist; 全身 is
      // controlled-vocab and survives refinement.
      expect(r.tags.map((t) => t.label)).toEqual(["全身"]);
      expect(r.keywordsJa).toEqual(["風景"]);
      expect(r.keywordsEn).toEqual(["sunset"]);
      // Phase 10-5D: safeRaw is built from FILTERED values — attribute terms
      // (female / asian / 女性 / woman) must not survive into rawJson.
      expect(r.safeRaw).toEqual({
        tags: [{ label: "全身" }],
        keywords_ja: ["風景"],
        keywords_en: ["sunset"],
        usage_category: "portrait",
        language_detected: "mixed",
      });
      const safeRawStr = JSON.stringify(r.safeRaw);
      for (const banned of ["female", "asian", "女性", "woman"]) {
        expect(safeRawStr).not.toContain(banned);
      }
    }
  });

  // Phase 10-10A: 人物/ポートレート are excluded end-to-end (too generic for
  // Photo.box — nearly every image would match).
  it("Phase 10-10A: excludes 人物 and ポートレート end-to-end", async () => {
    const r = await analyzePromptCore(
      { currentBody: "x", notes: null },
      DEPS({
        tags: [{ label: "人物" }, { label: "ポートレート" }, { label: "海" }],
        keywords_ja: [],
        keywords_en: [],
        usage_category: "other",
        language_detected: "ja",
      }),
    );
    expect(r.status).toBe("DONE");
    if (r.status === "DONE") expect(r.tags.map((t) => t.label)).toEqual(["海"]);
  });

  // Phase 10-10A: English time-of-day terms normalize to the JA tag end-to-end
  // (safety net for images analyzed in their original English prompt).
  it("Phase 10-10A: normalizes English time-of-day terms end-to-end (sunset → 夕方)", async () => {
    const r = await analyzePromptCore(
      { currentBody: "x", notes: null },
      DEPS({
        tags: [{ label: "sunset" }, { label: "海" }],
        keywords_ja: [],
        keywords_en: [],
        usage_category: "other",
        language_detected: "en",
      }),
    );
    expect(r.status).toBe("DONE");
    if (r.status === "DONE") {
      // time (夕方) sorts before place (海) by category priority.
      expect(r.tags.map((t) => t.label)).toEqual(["夕方", "海"]);
    }
  });

  // Phase 10-10B: bare "golden hour" is ambiguous (morning or evening light)
  // and must NOT survive as a time-of-day tag end-to-end.
  it("Phase 10-10B: 'golden hour' alone does not become 夕方 end-to-end", async () => {
    const r = await analyzePromptCore(
      { currentBody: "x", notes: null },
      DEPS({
        tags: [{ label: "golden hour" }, { label: "海" }],
        keywords_ja: [],
        keywords_en: [],
        usage_category: "other",
        language_detected: "en",
      }),
    );
    expect(r.status).toBe("DONE");
    if (r.status === "DONE") expect(r.tags.map((t) => t.label)).toEqual(["海"]);
  });

  it("Phase 10-10B: 'sunrise' becomes 朝 end-to-end", async () => {
    const r = await analyzePromptCore(
      { currentBody: "x", notes: null },
      DEPS({
        tags: [{ label: "sunrise" }, { label: "海" }],
        keywords_ja: [],
        keywords_en: [],
        usage_category: "other",
        language_detected: "en",
      }),
    );
    expect(r.status).toBe("DONE");
    if (r.status === "DONE") expect(r.tags.map((t) => t.label)).toEqual(["朝", "海"]);
  });

  it("Phase 10-10B: 'sunset' still becomes 夕方 end-to-end (unambiguous)", async () => {
    const r = await analyzePromptCore(
      { currentBody: "x", notes: null },
      DEPS({
        tags: [{ label: "sunset" }, { label: "海" }],
        keywords_ja: [],
        keywords_en: [],
        usage_category: "other",
        language_detected: "en",
      }),
    );
    expect(r.status).toBe("DONE");
    if (r.status === "DONE") expect(r.tags.map((t) => t.label)).toEqual(["夕方", "海"]);
  });

  // Phase 10-5E: end-to-end refinement through analyzePromptCore.
  it("drops 素材 / 参考画像 and out-of-vocab tags, keeps controlled-vocab", async () => {
    const r = await analyzePromptCore(
      { currentBody: "x", notes: null },
      DEPS({
        tags: [{ label: "素材" }, { label: "参考画像" }, { label: "海" }, { label: "エアリー" }],
        keywords_ja: [],
        keywords_en: [],
        usage_category: "other",
        language_detected: "ja",
      }),
    );
    expect(r.status).toBe("DONE");
    if (r.status === "DONE") expect(r.tags.map((t) => t.label)).toEqual(["海"]);
  });

  it("drops description-style banned labels (〜の描写)", async () => {
    const r = await analyzePromptCore(
      { currentBody: "x", notes: null },
      DEPS({
        tags: [{ label: "夕暮れ時の光学用シーンの描写" }, { label: "夜" }],
        keywords_ja: [],
        keywords_en: [],
        usage_category: "other",
        language_detected: "ja",
      }),
    );
    expect(r.status).toBe("DONE");
    if (r.status === "DONE") expect(r.tags.map((t) => t.label)).toEqual(["夜"]);
  });

  it("normalizes synonyms (海辺→海, プールサイド→プール)", async () => {
    const r = await analyzePromptCore(
      { currentBody: "x", notes: null },
      DEPS({
        tags: [{ label: "海辺" }, { label: "プールサイド" }],
        keywords_ja: [],
        keywords_en: [],
        usage_category: "other",
        language_detected: "ja",
      }),
    );
    expect(r.status).toBe("DONE");
    if (r.status === "DONE") expect(r.tags.map((t) => t.label)).toEqual(["海", "プール"]);
  });

  it("limits mood tags to 1 and caps total to 8, sorted by category priority", async () => {
    const r = await analyzePromptCore(
      { currentBody: "x", notes: null },
      DEPS({
        tags: [
          { label: "高級感" }, // mood
          { label: "クール" }, // mood (should be dropped by mood cap)
          { label: "風景" }, // subject
          { label: "逆光" }, // light
          { label: "全身" }, // composition
          { label: "海" }, // place
          { label: "水着" }, // outfit
          { label: "朝" }, // time
          { label: "料理" }, // subject
          { label: "商品" }, // subject
        ],
        keywords_ja: [],
        keywords_en: [],
        usage_category: "other",
        language_detected: "ja",
      }),
    );
    expect(r.status).toBe("DONE");
    if (r.status === "DONE") {
      expect(r.tags).toHaveLength(8);
      // priority: time → outfit → place → composition → light → subject → mood
      expect(r.tags.map((t) => t.label)).toEqual([
        "朝",
        "水着",
        "海",
        "全身",
        "逆光",
        "風景",
        "料理",
        "商品",
      ]);
      // only 1 mood tag survived, and it was pushed out by the 8-cap here
      const moods = r.tags.filter((t) => t.label === "高級感" || t.label === "クール");
      expect(moods.length).toBeLessThanOrEqual(1);
    }
  });

  // Phase 10-13C: end-to-end confirmation that removed generic/abstract/
  // low-value labels never survive analyzePromptCore, even if the (mock)
  // provider still returns them.
  it("Phase 10-13C: drops removed low-value labels end-to-end (自然光/ナチュラル/シンプル/室内/屋外/私服/リラックス)", async () => {
    const r = await analyzePromptCore(
      { currentBody: "x", notes: null },
      DEPS({
        tags: [
          { label: "自然光" },
          { label: "ナチュラル" },
          { label: "シンプル" },
          { label: "室内" },
          { label: "屋外" },
          { label: "私服" },
          { label: "リラックス" },
          { label: "海" },
        ],
        keywords_ja: [],
        keywords_en: [],
        usage_category: "other",
        language_detected: "ja",
      }),
    );
    expect(r.status).toBe("DONE");
    if (r.status === "DONE") expect(r.tags.map((t) => t.label)).toEqual(["海"]);
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

  it("schema-invalid output → FAILED, does NOT retain the un-filterable raw (Phase 10-5D)", async () => {
    const r = await analyzePromptCore(
      { currentBody: "x", notes: null },
      DEPS({ tags: "not-an-array", keywords_ja: [], keywords_en: [] }),
    );
    expect(r.status).toBe("FAILED");
    if (r.status === "FAILED") {
      expect(r.error).toBe("schema_validation_failed");
      // safeRaw is intentionally absent: schema-invalid output can't be filtered.
      expect(r.safeRaw).toBeUndefined();
    }
  });

  // Phase 10-5D: provider errors are sanitized before becoming result.error
  it("provider error containing an API key is sanitized (Phase 10-5D)", async () => {
    const r = await analyzePromptCore(
      { currentBody: "x", notes: null },
      { provider: createThrowingProvider("boom sk-secretKEY123_-"), schemaVersion: "prompt-v1" },
    );
    expect(r.status).toBe("FAILED");
    if (r.status === "FAILED") {
      expect(r.error).not.toContain("sk-secretKEY123_-");
      expect(r.error).toContain("[REDACTED_API_KEY]");
    }
  });
});

// Phase 10-5D: preparedText is used verbatim (route builds + truncates once)
describe("analyzePromptCore — preparedText", () => {
  it("uses preparedText verbatim instead of rebuilding from fields", async () => {
    let seen = "";
    const provider = {
      modelId: "mock",
      analyze: async (text: string) => {
        seen = text;
        return { tags: [], keywords_ja: [], keywords_en: [], usage_category: "other", language_detected: "ja" };
      },
    };
    const r = await analyzePromptCore(
      { currentBody: "IGNORED english body", notes: "IGNORED", preparedText: "切り詰め済み日本語テキスト" },
      { provider, schemaVersion: "prompt-v1" },
    );
    expect(seen).toBe("切り詰め済み日本語テキスト");
    expect(r.status).toBe("DONE");
  });

  it("empty preparedText → SKIPPED_NO_PROMPT, provider not called", async () => {
    let called = false;
    const provider = { modelId: "mock", analyze: async () => { called = true; return {}; } };
    const r = await analyzePromptCore(
      { currentBody: "has body", notes: null, preparedText: "" },
      { provider, schemaVersion: "prompt-v1" },
    );
    expect(r.status).toBe("SKIPPED_NO_PROMPT");
    expect(called).toBe(false);
  });

  it("promptHash reflects preparedText, not the raw fields", async () => {
    const r = await analyzePromptCore(
      { currentBody: "raw", notes: null, preparedText: "prepared text A" },
      DEPS({ tags: [], keywords_ja: [], keywords_en: [], usage_category: "other", language_detected: "ja" }),
    );
    expect(r.status).toBe("DONE");
    if (r.status === "DONE") {
      expect(r.promptHash).toBe(computePromptHash("prepared text A"));
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
