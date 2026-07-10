import { describe, it, expect } from "vitest";
import { truncateTranslationInput, buildTranslationUpdateData } from "@/lib/translation/singleTranslationPlan";

const NOW = new Date("2026-07-10T00:00:00.000Z");

describe("truncateTranslationInput", () => {
  it("returns text unchanged when within limit", () => {
    expect(truncateTranslationInput("short", 8000)).toEqual({ text: "short", truncated: false });
  });
  it("truncates and appends a marker when over limit", () => {
    const r = truncateTranslationInput("a".repeat(100), 10);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith("a".repeat(10))).toBe(true);
    expect(r.text).toContain("切り詰め");
  });
  it("boundary: exactly at limit is not truncated", () => {
    expect(truncateTranslationInput("abcde", 5)).toEqual({ text: "abcde", truncated: false });
  });
});

describe("buildTranslationUpdateData", () => {
  it("DONE: sets translated body/hash/provider/model, clears error & startedAt; NEVER touches currentBody/originalBody", () => {
    const data = buildTranslationUpdateData(
      { kind: "done", translatedText: "可愛い猫", bodyHash: "h1", providerId: "openai", modelId: "openai:gpt-4o-mini:tr-v1" },
      NOW,
    );
    expect(data).toEqual({
      translationStatus: "DONE",
      translatedBodyJa: "可愛い猫",
      translatedFromBodyHash: "h1",
      translationProvider: "openai",
      translationModel: "openai:gpt-4o-mini:tr-v1",
      translatedAt: NOW,
      translationStartedAt: null,
      translationError: null,
    });
    expect(data).not.toHaveProperty("currentBody");
    expect(data).not.toHaveProperty("originalBody");
  });

  it("SKIPPED_ALREADY_JA: stores currentBody verbatim as the translation, provider/model null", () => {
    const data = buildTranslationUpdateData(
      { kind: "skipped_already_ja", currentBody: "可愛い猫", bodyHash: "h2" },
      NOW,
    );
    expect(data).toEqual({
      translationStatus: "SKIPPED_ALREADY_JA",
      translatedBodyJa: "可愛い猫",
      translatedFromBodyHash: "h2",
      translationProvider: null,
      translationModel: null,
      translatedAt: NOW,
      translationStartedAt: null,
      translationError: null,
    });
  });

  it("FAILED: sets error/provider/model, clears startedAt, does NOT overwrite translatedBodyJa", () => {
    const data = buildTranslationUpdateData(
      { kind: "failed", error: "translation provider timeout", providerId: "openai", modelId: "openai:gpt-4o-mini:tr-v1" },
      NOW,
    );
    expect(data).toEqual({
      translationStatus: "FAILED",
      translationProvider: "openai",
      translationModel: "openai:gpt-4o-mini:tr-v1",
      translationStartedAt: null,
      translationError: "translation provider timeout",
    });
    // prior translation preserved (field absent from update)
    expect(data).not.toHaveProperty("translatedBodyJa");
    expect(data).not.toHaveProperty("currentBody");
  });

  it("FAILED with null provider/model (e.g. budget/config error before provider)", () => {
    const data = buildTranslationUpdateData(
      { kind: "failed", error: "translation daily budget exceeded", providerId: null, modelId: null },
      NOW,
    );
    expect(data.translationStatus).toBe("FAILED");
    expect(data.translationProvider).toBeNull();
    expect(data.translationModel).toBeNull();
    expect(data.translationError).toBe("translation daily budget exceeded");
  });
});
