import { describe, it, expect } from "vitest";
import { getAnalysisProviderFromEnv } from "@/lib/analysis/analysisProvider";

describe("getAnalysisProviderFromEnv", () => {
  it("ENABLED unset → mock (production default)", () => {
    const r = getAnalysisProviderFromEnv({});
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.providerId).toBe("mock");
      expect(r.modelId).toBe("mock:mock:ja-tags-v1");
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

  it("ENABLED=true + PROVIDER=openai → config_error in 10-5D-1 (real provider not yet implemented), even with a key", () => {
    const r = getAnalysisProviderFromEnv({
      AI_ANALYSIS_ENABLED: "true",
      AI_ANALYSIS_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-test",
      AI_ANALYSIS_MODEL: "gpt-4o-mini",
    });
    expect(r.kind).toBe("config_error");
    if (r.kind === "config_error") {
      expect(r.providerId).toBe("openai");
      expect(r.modelId).toBe("openai:gpt-4o-mini:ja-tags-v1");
      expect(r.error).toMatch(/not available yet/i);
    }
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
    if (r.kind === "config_error") expect(r.modelId).toContain(":ja-tags-v1");
  });
});
