import { describe, it, expect, vi } from "vitest";
import { getAnalysisProviderFromEnv, type CreateOpenAIProvider } from "@/lib/analysis/analysisProvider";

// A stand-in for createOpenAIProvider so this test avoids the openai SDK.
const fakeCreateOpenAI: CreateOpenAIProvider = vi.fn((cfg) => ({
  modelId: cfg.modelId,
  analyze: async () => ({ tags: [], keywords_ja: [], keywords_en: [], usage_category: "other", language_detected: "ja" }),
}));

describe("getAnalysisProviderFromEnv", () => {
  it("ENABLED unset → mock (production default)", () => {
    const r = getAnalysisProviderFromEnv({});
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.providerId).toBe("mock");
      expect(r.modelId).toBe("mock:mock:ja-tags-v4");
    }
  });

  it("ENABLED=true but PROVIDER=mock → mock", () => {
    const r = getAnalysisProviderFromEnv({ AI_ANALYSIS_ENABLED: "true", AI_ANALYSIS_PROVIDER: "mock" });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.providerId).toBe("mock");
  });

  it("ENABLED=false ignores PROVIDER=openai → mock", () => {
    const r = getAnalysisProviderFromEnv({ AI_ANALYSIS_ENABLED: "false", AI_ANALYSIS_PROVIDER: "openai" });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.providerId).toBe("mock");
  });

  it("ENABLED=true + PROVIDER=openai + key + factory wired → ok (real provider, Phase 10-5D-2)", () => {
    const r = getAnalysisProviderFromEnv(
      { AI_ANALYSIS_ENABLED: "true", AI_ANALYSIS_PROVIDER: "openai", OPENAI_API_KEY: "sk-test", AI_ANALYSIS_MODEL: "gpt-4o-mini" },
      { createOpenAI: fakeCreateOpenAI },
    );
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.providerId).toBe("openai");
      expect(r.modelId).toBe("openai:gpt-4o-mini:ja-tags-v4");
    }
  });

  it("ENABLED=true + PROVIDER=openai but OPENAI_API_KEY missing → config_error", () => {
    const r = getAnalysisProviderFromEnv(
      { AI_ANALYSIS_ENABLED: "true", AI_ANALYSIS_PROVIDER: "openai", AI_ANALYSIS_MODEL: "gpt-4o-mini" },
      { createOpenAI: fakeCreateOpenAI },
    );
    expect(r.kind).toBe("config_error");
    if (r.kind === "config_error") {
      expect(r.providerId).toBe("openai");
      expect(r.modelId).toBe("openai:gpt-4o-mini:ja-tags-v4");
      expect(r.error).toMatch(/OPENAI_API_KEY/);
    }
  });

  it("ENABLED=true + PROVIDER=openai + key but factory NOT wired → config_error", () => {
    const r = getAnalysisProviderFromEnv({
      AI_ANALYSIS_ENABLED: "true",
      AI_ANALYSIS_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-test",
    });
    expect(r.kind).toBe("config_error");
    if (r.kind === "config_error") expect(r.error).toMatch(/factory not wired/i);
  });

  it("ENABLED=true + PROVIDER=gemini → config_error (unsupported)", () => {
    const r = getAnalysisProviderFromEnv({ AI_ANALYSIS_ENABLED: "true", AI_ANALYSIS_PROVIDER: "gemini" });
    expect(r.kind).toBe("config_error");
    if (r.kind === "config_error") expect(r.providerId).toBe("gemini");
  });

  it("ENABLED=true + unknown provider → config_error", () => {
    const r = getAnalysisProviderFromEnv({ AI_ANALYSIS_ENABLED: "true", AI_ANALYSIS_PROVIDER: "banana" });
    expect(r.kind).toBe("config_error");
    if (r.kind === "config_error") expect(r.error).toMatch(/Unsupported/);
  });

  it("config_error always carries a composite modelId for the FAILED cache key", () => {
    const r = getAnalysisProviderFromEnv({ AI_ANALYSIS_ENABLED: "true", AI_ANALYSIS_PROVIDER: "openai" });
    if (r.kind === "config_error") expect(r.modelId).toContain(":ja-tags-v4");
  });
});
