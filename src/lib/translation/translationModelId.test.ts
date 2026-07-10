import { describe, it, expect } from "vitest";
import { TRANSLATION_PROMPT_VERSION, buildTranslationModelId } from "@/lib/translation/translationModelId";

describe("buildTranslationModelId", () => {
  it("composes provider:model:promptVersion", () => {
    expect(buildTranslationModelId({ provider: "mock", model: "mock", promptVersion: TRANSLATION_PROMPT_VERSION })).toBe(
      "mock:mock:tr-v1",
    );
    expect(buildTranslationModelId({ provider: "openai", model: "gpt-4o-mini", promptVersion: TRANSLATION_PROMPT_VERSION })).toBe(
      "openai:gpt-4o-mini:tr-v1",
    );
  });
  it("different promptVersion → different modelId (cache/audit separation)", () => {
    expect(buildTranslationModelId({ provider: "openai", model: "m", promptVersion: "tr-v1" })).not.toBe(
      buildTranslationModelId({ provider: "openai", model: "m", promptVersion: "tr-v2" }),
    );
  });
});
