// Phase 10-11B: deterministic mock prompt-variation provider for tests and the
// PROMPT_VARIATION_ENABLED=false default (no network, no real LLM). It appends
// a readable marker naming the requested change dimensions to the original
// prompt — enough to prove the wiring end-to-end without a real generation. A
// real OpenAI provider produces genuine rewrites via its own system prompt.
import type { PromptVariationProvider } from "./provider";
import type { VariationChange } from "./types";

const CHANGE_LABEL: Record<VariationChange, string> = {
  pose: "pose",
  outfit: "outfit",
  expression: "expression",
  place: "place",
  mood_time: "mood/time",
};

export function createMockVariationProvider(modelId = "mock"): PromptVariationProvider {
  return {
    providerId: "mock",
    modelId,
    generate: async (originalPrompt: string, changes: VariationChange[]) => {
      const applied = changes.map((c) => CHANGE_LABEL[c]).join(", ");
      return { text: `${originalPrompt.trim()} [MOCK-VARIATION changed: ${applied}]` };
    },
  };
}
