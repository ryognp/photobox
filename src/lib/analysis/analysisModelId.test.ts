import { describe, it, expect } from "vitest";
import { ANALYSIS_PROMPT_VERSION, buildAnalysisModelId } from "@/lib/analysis/analysisModelId";

describe("buildAnalysisModelId", () => {
  it("current prompt version is ja-tags-v4 (bumped in Phase 10-10B)", () => {
    expect(ANALYSIS_PROMPT_VERSION).toBe("ja-tags-v4");
  });

  it("composes provider:model:promptVersion", () => {
    expect(buildAnalysisModelId({ provider: "mock", model: "mock", promptVersion: ANALYSIS_PROMPT_VERSION })).toBe(
      "mock:mock:ja-tags-v4",
    );
    expect(buildAnalysisModelId({ provider: "openai", model: "gpt-4o-mini", promptVersion: ANALYSIS_PROMPT_VERSION })).toBe(
      "openai:gpt-4o-mini:ja-tags-v4",
    );
  });

  it("different promptVersion produces a different modelId (cache bust)", () => {
    const v1 = buildAnalysisModelId({ provider: "openai", model: "gpt-4o-mini", promptVersion: "ja-tags-v1" });
    const v2 = buildAnalysisModelId({ provider: "openai", model: "gpt-4o-mini", promptVersion: "ja-tags-v2" });
    expect(v1).not.toBe(v2);
  });
});
