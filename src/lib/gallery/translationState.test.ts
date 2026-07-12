import { describe, it, expect } from "vitest";
import { applyTranslationUpdate, applyPromptEditToDetailPrompt } from "@/lib/gallery/translationState";
import type { ImageDetail, TranslatePromptResult } from "@/lib/gallery/imagesClient";

type DetailPrompt = NonNullable<ImageDetail["prompt"]>;

function makePrompt(over: Partial<DetailPrompt> = {}): DetailPrompt {
  return {
    id: "p1",
    currentBody: "a cute cat",
    originalBody: "a cute cat",
    createdAt: "2026-07-10T00:00:00.000Z",
    versions: [],
    translatedBodyJa: null,
    translatedFromBodyHash: null,
    translationStatus: "NONE",
    translationProvider: null,
    translationModel: null,
    translatedAt: null,
    translationStartedAt: null,
    translationError: null,
    effectiveTranslatedBodyJa: null,
    ...over,
  };
}

function makeDetail(prompt: DetailPrompt | null): ImageDetail {
  return {
    id: "img1",
    originalName: "x.png",
    originalExt: "png",
    mimeType: "image/png",
    fileSizeBytes: 1,
    widthPx: null,
    heightPx: null,
    fileHashSnippet: null,
    isFavorite: false,
    rating: null,
    notes: null,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    sourceSheetName: null,
    sourceRow: null,
    sourceColumn: null,
    importBatchId: null,
    scene: null,
    tags: [],
    persons: [],
    tagSuggestions: [],
    prompt,
    signedUrls: { thumbnailUrl: null, previewUrl: null, originalUrl: null },
    translationEnabled: true,
    variationEnabled: false,
  };
}

describe("applyTranslationUpdate", () => {
  it("DONE → sets effectiveTranslatedBodyJa + mirrors raw fields", () => {
    const detail = makeDetail(makePrompt());
    const result: TranslatePromptResult = {
      status: "DONE",
      translation: {
        translatedBodyJa: "可愛い猫",
        translationStatus: "DONE",
        translationProvider: "openai",
        translationModel: "openai:gpt-4o-mini:tr-v1",
        translatedAt: "2026-07-10T01:00:00.000Z",
        translationError: null,
      },
    };
    const next = applyTranslationUpdate(detail, result);
    expect(next.prompt?.effectiveTranslatedBodyJa).toBe("可愛い猫");
    expect(next.prompt?.translationStatus).toBe("DONE");
    expect(next.prompt?.translatedBodyJa).toBe("可愛い猫");
    // original English body untouched
    expect(next.prompt?.currentBody).toBe("a cute cat");
  });

  it("SKIPPED_ALREADY_JA → effective is the stored body", () => {
    const detail = makeDetail(makePrompt({ currentBody: "可愛い猫" }));
    const result: TranslatePromptResult = {
      status: "SKIPPED_ALREADY_JA",
      translation: {
        translatedBodyJa: "可愛い猫",
        translationStatus: "SKIPPED_ALREADY_JA",
        translationProvider: null,
        translationModel: null,
        translatedAt: "2026-07-10T01:00:00.000Z",
        translationError: null,
      },
    };
    expect(applyTranslationUpdate(detail, result).prompt?.effectiveTranslatedBodyJa).toBe("可愛い猫");
  });

  it("FAILED → keeps the previous effective translation, records error", () => {
    const detail = makeDetail(
      makePrompt({ effectiveTranslatedBodyJa: "以前の訳", translatedBodyJa: "以前の訳", translationStatus: "DONE" }),
    );
    const result: TranslatePromptResult = {
      status: "FAILED",
      translation: {
        translatedBodyJa: "以前の訳", // server preserves prior on FAILED
        translationStatus: "FAILED",
        translationProvider: "openai",
        translationModel: "openai:gpt-4o-mini:tr-v1",
        translatedAt: "2026-07-10T00:00:00.000Z",
        translationError: "translation provider timeout",
      },
    };
    const next = applyTranslationUpdate(detail, result);
    expect(next.prompt?.effectiveTranslatedBodyJa).toBe("以前の訳");
    expect(next.prompt?.translationStatus).toBe("FAILED");
    expect(next.prompt?.translationError).toBe("translation provider timeout");
  });

  it("stale / disabled / no_prompt → effective unchanged, no crash on null translation", () => {
    const detail = makeDetail(makePrompt({ effectiveTranslatedBodyJa: "現行訳" }));
    for (const status of ["stale", "disabled", "no_prompt"] as const) {
      const next = applyTranslationUpdate(detail, { status, translation: null });
      expect(next.prompt?.effectiveTranslatedBodyJa).toBe("現行訳");
    }
  });

  it("no prompt → returns detail unchanged", () => {
    const detail = makeDetail(null);
    expect(applyTranslationUpdate(detail, { status: "DONE", translation: null })).toBe(detail);
  });
});

describe("applyPromptEditToDetailPrompt", () => {
  it("body unchanged → keeps translation fields", () => {
    const prev = makePrompt({
      effectiveTranslatedBodyJa: "訳",
      translatedBodyJa: "訳",
      translationStatus: "DONE",
      translatedFromBodyHash: "h",
    });
    // PATCH response shape: only id/originalBody/currentBody/versions present at
    // runtime (translation fields absent) — cast through unknown to mirror that.
    const saved = { id: "p1", originalBody: "a cute cat", currentBody: "a cute cat", versions: [] } as unknown as DetailPrompt;
    const merged = applyPromptEditToDetailPrompt(prev, saved);
    expect(merged.effectiveTranslatedBodyJa).toBe("訳");
    expect(merged.translationStatus).toBe("DONE");
  });

  it("body changed → clears translation + effectiveTranslatedBodyJa", () => {
    const prev = makePrompt({
      effectiveTranslatedBodyJa: "古い訳",
      translatedBodyJa: "古い訳",
      translationStatus: "DONE",
      translatedFromBodyHash: "h",
      translationProvider: "openai",
    });
    const saved = { id: "p1", originalBody: "a cute cat", currentBody: "a happy dog", versions: [] } as unknown as DetailPrompt;
    const merged = applyPromptEditToDetailPrompt(prev, saved);
    expect(merged.currentBody).toBe("a happy dog");
    expect(merged.effectiveTranslatedBodyJa).toBeNull();
    expect(merged.translatedBodyJa).toBeNull();
    expect(merged.translationStatus).toBe("NONE");
    expect(merged.translatedFromBodyHash).toBeNull();
    expect(merged.translationProvider).toBeNull();
  });
});
