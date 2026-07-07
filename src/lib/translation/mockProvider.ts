import type { TranslationProvider } from "./provider";

/**
 * Deterministic mock translation provider (Phase 10-5B). No network, no real
 * LLM. The "[MOCK-JA] " prefix makes it obvious in DB/UI that a real
 * translation has NOT happened yet — never removed accidentally in a real
 * provider's output.
 */
export function createMockTranslationProvider(modelId = "mock-v1"): TranslationProvider {
  return {
    providerId: "mock",
    modelId,
    translate: async (text: string) => ({ text: `[MOCK-JA] ${text}` }),
  };
}

/** A provider that always throws — for FAILED-path tests. */
export function createThrowingTranslationProvider(
  message = "translation provider error",
  modelId = "mock-v1",
): TranslationProvider {
  return {
    providerId: "mock",
    modelId,
    translate: async () => {
      throw new Error(message);
    },
  };
}
