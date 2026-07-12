import { describe, it, expect, vi } from "vitest";
import {
  getVariationProviderFromEnv,
  isVariationEnabled,
  type CreateOpenAIVariationProvider,
} from "@/lib/promptVariation/variationProviderFactory";

const fakeCreateOpenAI: CreateOpenAIVariationProvider = vi.fn((cfg) => ({
  providerId: "openai",
  modelId: cfg.modelId,
  generate: async () => ({ text: "fake" }),
}));

const OPENAI_ENV = {
  PROMPT_VARIATION_ENABLED: "true",
  PROMPT_VARIATION_PROVIDER: "openai",
  OPENAI_API_KEY: "sk-test",
  PROMPT_VARIATION_MODEL: "gpt-4o-mini",
};

describe("isVariationEnabled", () => {
  it("false when disabled / mock / no key", () => {
    expect(isVariationEnabled({})).toBe(false);
    expect(isVariationEnabled({ PROMPT_VARIATION_ENABLED: "true", PROMPT_VARIATION_PROVIDER: "mock" })).toBe(false);
    expect(isVariationEnabled({ PROMPT_VARIATION_ENABLED: "true", PROMPT_VARIATION_PROVIDER: "openai" })).toBe(false);
  });
  it("true only when enabled + openai + key", () => {
    expect(isVariationEnabled(OPENAI_ENV)).toBe(true);
    // falls back to OPENAI_API_KEY / dedicated key
    expect(
      isVariationEnabled({
        PROMPT_VARIATION_ENABLED: "true",
        PROMPT_VARIATION_PROVIDER: "openai",
        PROMPT_VARIATION_OPENAI_API_KEY: "sk-dedicated",
      }),
    ).toBe(true);
  });
});

describe("getVariationProviderFromEnv", () => {
  it("disabled → mock (production default)", () => {
    const r = getVariationProviderFromEnv({});
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.providerId).toBe("mock");
      expect(r.modelId).toBe("mock:mock:prompt-var-v1");
    }
  });

  it("enabled but provider=mock → mock", () => {
    const r = getVariationProviderFromEnv({ PROMPT_VARIATION_ENABLED: "true", PROMPT_VARIATION_PROVIDER: "mock" });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.providerId).toBe("mock");
  });

  it("enabled + openai + key + factory → ok (real provider)", () => {
    const r = getVariationProviderFromEnv(OPENAI_ENV, { createOpenAI: fakeCreateOpenAI });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.providerId).toBe("openai");
      expect(r.modelId).toBe("openai:gpt-4o-mini:prompt-var-v1");
    }
  });

  it("enabled + openai + NO key → config_error (composite modelId present)", () => {
    const r = getVariationProviderFromEnv(
      { PROMPT_VARIATION_ENABLED: "true", PROMPT_VARIATION_PROVIDER: "openai", PROMPT_VARIATION_MODEL: "gpt-4o-mini" },
      { createOpenAI: fakeCreateOpenAI },
    );
    expect(r.kind).toBe("config_error");
    if (r.kind === "config_error") {
      expect(r.modelId).toBe("openai:gpt-4o-mini:prompt-var-v1");
      expect(r.error).toMatch(/API key/);
    }
  });

  it("enabled + openai + key but factory NOT wired → config_error", () => {
    const r = getVariationProviderFromEnv({
      PROMPT_VARIATION_ENABLED: "true",
      PROMPT_VARIATION_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-test",
    });
    expect(r.kind).toBe("config_error");
    if (r.kind === "config_error") expect(r.error).toMatch(/factory not wired/i);
  });

  it("enabled + unknown provider → config_error", () => {
    const r = getVariationProviderFromEnv({ PROMPT_VARIATION_ENABLED: "true", PROMPT_VARIATION_PROVIDER: "banana" });
    expect(r.kind).toBe("config_error");
    if (r.kind === "config_error") expect(r.error).toMatch(/Unsupported/);
  });
});
