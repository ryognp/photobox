import { describe, it, expect } from "vitest";
import {
  DEFAULT_TRANSLATION_TIMEOUT_MS,
  DEFAULT_TRANSLATION_MAX_INPUT_CHARS,
  DEFAULT_TRANSLATION_DAILY_CALL_LIMIT,
  readTranslationTimeoutMs,
  readTranslationMaxInputChars,
  readTranslationDailyCallLimit,
  resolveTranslationApiKey,
} from "@/lib/translation/translationConfig";

describe("translation config readers", () => {
  it("fall back to defaults when unset / invalid", () => {
    expect(readTranslationTimeoutMs({})).toBe(DEFAULT_TRANSLATION_TIMEOUT_MS);
    expect(readTranslationMaxInputChars({ TRANSLATION_MAX_INPUT_CHARS: "0" })).toBe(DEFAULT_TRANSLATION_MAX_INPUT_CHARS);
    expect(readTranslationDailyCallLimit({ TRANSLATION_DAILY_CALL_LIMIT: "-3" })).toBe(DEFAULT_TRANSLATION_DAILY_CALL_LIMIT);
    expect(readTranslationTimeoutMs({ TRANSLATION_TIMEOUT_MS: "NaN" })).toBe(DEFAULT_TRANSLATION_TIMEOUT_MS);
  });
  it("read valid values", () => {
    expect(readTranslationTimeoutMs({ TRANSLATION_TIMEOUT_MS: "30000" })).toBe(30000);
    expect(readTranslationMaxInputChars({ TRANSLATION_MAX_INPUT_CHARS: "6000" })).toBe(6000);
    expect(readTranslationDailyCallLimit({ TRANSLATION_DAILY_CALL_LIMIT: "5" })).toBe(5);
  });
});

describe("resolveTranslationApiKey (fallback)", () => {
  it("prefers TRANSLATION_OPENAI_API_KEY", () => {
    expect(resolveTranslationApiKey({ TRANSLATION_OPENAI_API_KEY: "sk-t", OPENAI_API_KEY: "sk-a" })).toBe("sk-t");
  });
  it("falls back to OPENAI_API_KEY", () => {
    expect(resolveTranslationApiKey({ OPENAI_API_KEY: "sk-a" })).toBe("sk-a");
  });
  it("undefined when neither set / blank", () => {
    expect(resolveTranslationApiKey({})).toBeUndefined();
    expect(resolveTranslationApiKey({ OPENAI_API_KEY: "" })).toBeUndefined();
  });
});
