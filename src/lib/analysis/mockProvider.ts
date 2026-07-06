import type { PromptAnalysisProvider } from "./provider";

/**
 * Deterministic mock provider for tests and Phase 10-1 wiring (no network, no
 * real LLM). Returns a fixed-shape structured output derived from the input so
 * core validation/normalization can be exercised. Real OpenAI provider is a
 * later phase.
 */
export function createMockProvider(
  output?: unknown,
  modelId = "mock",
): PromptAnalysisProvider {
  return {
    modelId,
    analyze: async (text: string) => {
      if (output !== undefined) return output;
      // Default plausible output; token-ish tags from the first few words.
      const words = text.split(/\s+/).filter(Boolean).slice(0, 3);
      return {
        tags: words.map((w) => ({ label: w.slice(0, 40), confidence: 0.5 })),
        keywords_ja: [],
        keywords_en: words,
        usage_category: "other",
        language_detected: "mixed",
      };
    },
  };
}

/** A provider that always throws — for FAILED-path tests. */
export function createThrowingProvider(message = "provider error", modelId = "mock"): PromptAnalysisProvider {
  return {
    modelId,
    analyze: async () => {
      throw new Error(message);
    },
  };
}
