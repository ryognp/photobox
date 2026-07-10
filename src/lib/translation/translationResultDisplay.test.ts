import { describe, it, expect } from "vitest";
import { describeTranslationResult } from "@/lib/translation/translationResultDisplay";
import type { TranslatePromptResult } from "@/lib/gallery/imagesClient";

const translation = (over: Partial<NonNullable<TranslatePromptResult["translation"]>> = {}) => ({
  translatedBodyJa: "可愛い猫",
  translationStatus: "DONE" as const,
  translationProvider: "openai",
  translationModel: "openai:gpt-4o-mini:tr-v1",
  translatedAt: "2026-07-10T00:00:00.000Z",
  translationError: null,
  ...over,
});

describe("describeTranslationResult", () => {
  it("DONE (fresh) → ok, 作成", () => {
    const r: TranslatePromptResult = { status: "DONE", translation: translation() };
    expect(describeTranslationResult(r)).toEqual({ text: "日本語訳を作成しました", tone: "ok" });
  });

  it("DONE (cached) → ok, キャッシュ済み", () => {
    const r: TranslatePromptResult = { status: "DONE", cached: true, translation: translation() };
    expect(describeTranslationResult(r)?.text).toContain("キャッシュ済み");
    expect(describeTranslationResult(r)?.tone).toBe("ok");
  });

  it("SKIPPED_ALREADY_JA → info", () => {
    const r: TranslatePromptResult = {
      status: "SKIPPED_ALREADY_JA",
      translation: translation({ translationStatus: "SKIPPED_ALREADY_JA" }),
    };
    expect(describeTranslationResult(r)).toEqual({ text: "このプロンプトは既に日本語です", tone: "info" });
  });

  it("FAILED → error with translationError", () => {
    const r: TranslatePromptResult = {
      status: "FAILED",
      translation: translation({ translationStatus: "FAILED", translationError: "translation provider timeout" }),
    };
    const m = describeTranslationResult(r);
    expect(m?.tone).toBe("error");
    expect(m?.text).toContain("translation provider timeout");
  });

  it("FAILED without error text → 不明なエラー", () => {
    const r: TranslatePromptResult = { status: "FAILED", translation: null };
    expect(describeTranslationResult(r)?.text).toContain("不明なエラー");
  });

  it("disabled → info (defensive)", () => {
    const r: TranslatePromptResult = { status: "disabled", translation: null };
    expect(describeTranslationResult(r)?.tone).toBe("info");
  });

  it("stale → info reload message", () => {
    const r: TranslatePromptResult = { status: "stale", translation: null };
    const m = describeTranslationResult(r);
    expect(m?.tone).toBe("info");
    expect(m?.text).toContain("原文が変更されました");
  });

  it("no_prompt → null (ignored)", () => {
    const r: TranslatePromptResult = { status: "no_prompt", translation: null };
    expect(describeTranslationResult(r)).toBeNull();
  });
});
