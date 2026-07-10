import { describe, it, expect, vi } from "vitest";
import {
  getTranslationProviderFromEnv,
  isTranslationEnabled,
  type CreateOpenAITranslationProvider,
} from "@/lib/translation/translationProviderFactory";

const fakeCreateOpenAI: CreateOpenAITranslationProvider = vi.fn((cfg) => ({
  providerId: "openai",
  modelId: cfg.modelId,
  translate: async () => ({ text: "訳文" }),
}));

const OPENAI_ENV = {
  TRANSLATION_ENABLED: "true",
  TRANSLATION_PROVIDER: "openai",
  TRANSLATION_MODEL: "gpt-4o-mini",
  OPENAI_API_KEY: "sk-a",
};

describe("isTranslationEnabled (strict gate)", () => {
  it("false when disabled", () => {
    expect(isTranslationEnabled({ TRANSLATION_PROVIDER: "openai", OPENAI_API_KEY: "sk-a" })).toBe(false);
  });
  it("false when provider is mock (even if enabled + key)", () => {
    expect(isTranslationEnabled({ TRANSLATION_ENABLED: "true", TRANSLATION_PROVIDER: "mock", OPENAI_API_KEY: "sk-a" })).toBe(false);
  });
  it("false when no api key", () => {
    expect(isTranslationEnabled({ TRANSLATION_ENABLED: "true", TRANSLATION_PROVIDER: "openai" })).toBe(false);
  });
  it("true only when all three hold (with OPENAI_API_KEY fallback)", () => {
    expect(isTranslationEnabled(OPENAI_ENV)).toBe(true);
  });
  it("true with dedicated TRANSLATION_OPENAI_API_KEY", () => {
    expect(
      isTranslationEnabled({ TRANSLATION_ENABLED: "true", TRANSLATION_PROVIDER: "openai", TRANSLATION_OPENAI_API_KEY: "sk-t" }),
    ).toBe(true);
  });
});

describe("getTranslationProviderFromEnv", () => {
  it("disabled → mock", () => {
    const r = getTranslationProviderFromEnv({});
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.providerId).toBe("mock");
      expect(r.modelId).toBe("mock:mock:tr-v2");
    }
  });

  it("enabled but provider=mock → mock", () => {
    const r = getTranslationProviderFromEnv({ TRANSLATION_ENABLED: "true", TRANSLATION_PROVIDER: "mock" });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.providerId).toBe("mock");
  });

  it("enabled + openai + key + factory → ok (real provider)", () => {
    const r = getTranslationProviderFromEnv(OPENAI_ENV, { createOpenAI: fakeCreateOpenAI });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.providerId).toBe("openai");
      expect(r.modelId).toBe("openai:gpt-4o-mini:tr-v2");
    }
  });

  it("enabled + openai + NO key → config_error", () => {
    const r = getTranslationProviderFromEnv(
      { TRANSLATION_ENABLED: "true", TRANSLATION_PROVIDER: "openai" },
      { createOpenAI: fakeCreateOpenAI },
    );
    expect(r.kind).toBe("config_error");
    if (r.kind === "config_error") expect(r.error).toMatch(/api key/i);
  });

  it("enabled + openai + key but factory NOT wired → config_error", () => {
    const r = getTranslationProviderFromEnv(OPENAI_ENV);
    expect(r.kind).toBe("config_error");
    if (r.kind === "config_error") expect(r.error).toMatch(/not wired/i);
  });

  it("unknown provider → config_error", () => {
    const r = getTranslationProviderFromEnv({ TRANSLATION_ENABLED: "true", TRANSLATION_PROVIDER: "deepl" });
    expect(r.kind).toBe("config_error");
    if (r.kind === "config_error") expect(r.error).toMatch(/Unsupported/);
  });
});
