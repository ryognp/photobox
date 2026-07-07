import { describe, it, expect } from "vitest";
import {
  isJapaneseText,
  computeBodyHash,
  decideTranslationTarget,
  getEffectiveJapanesePromptBody,
  resetTranslationCacheData,
  sanitizeTranslationError,
} from "@/lib/translation/translationCore";

describe("isJapaneseText", () => {
  it("detects hiragana/katakana/kanji", () => {
    expect(isJapaneseText("猫がいます")).toBe(true);
    expect(isJapaneseText("ネコ")).toBe(true);
    expect(isJapaneseText("ねこ")).toBe(true);
  });
  it("false for pure English", () => {
    expect(isJapaneseText("a cute cat sitting on a chair")).toBe(false);
  });
  it("false for emoji-only / empty", () => {
    expect(isJapaneseText("🐱🐱🐱")).toBe(false);
    expect(isJapaneseText("")).toBe(false);
  });
  it("true for mixed EN+JA", () => {
    expect(isJapaneseText("a cat 猫")).toBe(true);
  });
});

describe("computeBodyHash", () => {
  it("stable for same normalized input, differs otherwise", () => {
    expect(computeBodyHash("a cat")).toBe(computeBodyHash("a cat"));
    expect(computeBodyHash("a   cat  ")).toBe(computeBodyHash("a cat"));
    expect(computeBodyHash("a cat")).not.toBe(computeBodyHash("a dog"));
  });
});

describe("decideTranslationTarget", () => {
  it("Japanese text is skipped even with force=true (regression: force must not override JA skip)", () => {
    const d = decideTranslationTarget({
      currentBody: "猫がいます",
      translationStatus: "NONE",
      translatedFromBodyHash: null,
      force: true,
    });
    expect(d.action).toBe("skip_already_ja");
  });

  it("English + DONE + matching hash + !force → skip_cached", () => {
    const body = "a cute cat";
    const hash = computeBodyHash(body);
    const d = decideTranslationTarget({
      currentBody: body,
      translationStatus: "DONE",
      translatedFromBodyHash: hash,
      force: false,
    });
    expect(d.action).toBe("skip_cached");
  });

  it("English + DONE + mismatched hash → translate (body changed since last translation)", () => {
    const d = decideTranslationTarget({
      currentBody: "a cute cat",
      translationStatus: "DONE",
      translatedFromBodyHash: "stale-hash",
      force: false,
    });
    expect(d.action).toBe("translate");
  });

  it("English + DONE + matching hash + force=true → translate (force overrides cache, not JA skip)", () => {
    const body = "a cute cat";
    const hash = computeBodyHash(body);
    const d = decideTranslationTarget({
      currentBody: body,
      translationStatus: "DONE",
      translatedFromBodyHash: hash,
      force: true,
    });
    expect(d.action).toBe("translate");
  });

  it("English + NONE → translate", () => {
    const d = decideTranslationTarget({
      currentBody: "a cute cat",
      translationStatus: "NONE",
      translatedFromBodyHash: null,
      force: false,
    });
    expect(d.action).toBe("translate");
  });
});

describe("getEffectiveJapanesePromptBody", () => {
  it("DONE + matching hash → returns translatedBodyJa", () => {
    const currentBody = "a cute cat";
    const hash = computeBodyHash(currentBody);
    expect(
      getEffectiveJapanesePromptBody({
        currentBody,
        translatedBodyJa: "可愛い猫",
        translatedFromBodyHash: hash,
        translationStatus: "DONE",
      }),
    ).toBe("可愛い猫");
  });

  it("SKIPPED_ALREADY_JA + matching hash → returns translatedBodyJa", () => {
    const currentBody = "可愛い猫";
    const hash = computeBodyHash(currentBody);
    expect(
      getEffectiveJapanesePromptBody({
        currentBody,
        translatedBodyJa: currentBody,
        translatedFromBodyHash: hash,
        translationStatus: "SKIPPED_ALREADY_JA",
      }),
    ).toBe(currentBody);
  });

  it("DONE + mismatched hash (stale translation) → null", () => {
    expect(
      getEffectiveJapanesePromptBody({
        currentBody: "a cute cat, edited",
        translatedBodyJa: "可愛い猫",
        translatedFromBodyHash: "stale-hash",
        translationStatus: "DONE",
      }),
    ).toBeNull();
  });

  it("FAILED → null regardless of translatedBodyJa presence", () => {
    const currentBody = "a cute cat";
    const hash = computeBodyHash(currentBody);
    expect(
      getEffectiveJapanesePromptBody({
        currentBody,
        translatedBodyJa: "可愛い猫",
        translatedFromBodyHash: hash,
        translationStatus: "FAILED",
      }),
    ).toBeNull();
  });

  it("presence of translatedBodyJa alone (wrong status) never wins", () => {
    const currentBody = "a cute cat";
    const hash = computeBodyHash(currentBody);
    expect(
      getEffectiveJapanesePromptBody({
        currentBody,
        translatedBodyJa: "可愛い猫",
        translatedFromBodyHash: hash,
        translationStatus: "PENDING",
      }),
    ).toBeNull();
  });
});

describe("resetTranslationCacheData", () => {
  it("returns all-null/NONE fragment", () => {
    expect(resetTranslationCacheData()).toEqual({
      translatedBodyJa: null,
      translatedFromBodyHash: null,
      translationStatus: "NONE",
      translationProvider: null,
      translationModel: null,
      translatedAt: null,
      translationStartedAt: null,
      translationError: null,
    });
  });
});

describe("sanitizeTranslationError", () => {
  it("redacts API-key-like substrings", () => {
    const msg = sanitizeTranslationError(new Error("failed with key sk-abc123XYZ_-"));
    expect(msg).not.toContain("sk-abc123XYZ_-");
    expect(msg).toContain("[REDACTED_API_KEY]");
  });
  it("truncates to 500 chars", () => {
    const long = "x".repeat(1000);
    expect(sanitizeTranslationError(new Error(long)).length).toBe(500);
  });
  it("handles non-Error input", () => {
    expect(sanitizeTranslationError("plain string")).toBe("plain string");
    expect(sanitizeTranslationError(123)).toBe("translation failed");
  });
});
