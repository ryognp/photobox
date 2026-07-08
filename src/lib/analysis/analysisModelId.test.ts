import { describe, it, expect } from "vitest";
import { ANALYSIS_PROMPT_VERSION, buildAnalysisModelId } from "@/lib/analysis/analysisModelId";

describe("buildAnalysisModelId", () => {
  it("composes provider:model:promptVersion", () => {
    expect(buildAnalysisModelId({ provider: "mock", model: "mock", promptVersion: ANALYSIS_PROMPT_VERSION })).toBe(
      "mock:mock:ja-tags-v1",
    );
    expect(buildAnalysisModelId({ provider: "openai", model: "gpt-4o-mini", promptVersion: ANALYSIS_PROMPT_VERSION })).toBe(
      "openai:gpt-4o-mini:ja-tags-v1",
    );
  });

  it("different promptVersion produces a different modelId (cache bust)", () => {
    const v1 = buildAnalysisModelId({ provider: "openai", model: "gpt-4o-mini", promptVersion: "ja-tags-v1" });
    const v2 = buildAnalysisModelId({ provider: "openai", model: "gpt-4o-mini", promptVersion: "ja-tags-v2" });
    expect(v1).not.toBe(v2);
  });
});
