import { describe, it, expect } from "vitest";
import { PROMPT_VARIATION_PROMPT_VERSION, buildVariationModelId } from "@/lib/promptVariation/variationModelId";

describe("buildVariationModelId", () => {
  it("current prompt version is prompt-var-v1", () => {
    expect(PROMPT_VARIATION_PROMPT_VERSION).toBe("prompt-var-v1");
  });

  it("composes provider:model:promptVersion", () => {
    expect(
      buildVariationModelId({ provider: "mock", model: "mock", promptVersion: PROMPT_VARIATION_PROMPT_VERSION }),
    ).toBe("mock:mock:prompt-var-v1");
    expect(
      buildVariationModelId({ provider: "openai", model: "gpt-4o-mini", promptVersion: PROMPT_VARIATION_PROMPT_VERSION }),
    ).toBe("openai:gpt-4o-mini:prompt-var-v1");
  });

  it("different promptVersion → different modelId", () => {
    expect(buildVariationModelId({ provider: "openai", model: "m", promptVersion: "prompt-var-v1" })).not.toBe(
      buildVariationModelId({ provider: "openai", model: "m", promptVersion: "prompt-var-v2" }),
    );
  });
});
