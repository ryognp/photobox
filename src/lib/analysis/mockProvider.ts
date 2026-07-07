import type { PromptAnalysisProvider } from "./provider";

/**
 * English keyword → Japanese tag label, for the mock provider's default
 * output (Phase 10-5C). This is NOT translation logic — just a small fixed
 * lookup so mock-generated tags read as Japanese, matching the app's
 * Japanese-first tag policy. A real provider (later phase) generates
 * genuine Japanese labels via its own prompt/schema.
 */
const KEYWORD_TO_JA_TAG: Record<string, string> = {
  portrait: "ポートレート",
  person: "人物",
  people: "人物",
  cafe: "カフェ",
  coffee: "カフェ",
  dog: "犬",
  cat: "猫",
  food: "料理",
  dish: "料理",
  meal: "料理",
  product: "商品",
  background: "背景",
  landscape: "風景",
  mountain: "風景",
  ocean: "風景",
  sea: "風景",
  beach: "風景",
  sky: "風景",
  city: "街並み",
  street: "街並み",
  flower: "花",
  flowers: "花",
};

/** Falls back to a generic Japanese label when no keyword mapping matches. */
const FALLBACK_JA_TAGS = ["素材", "参考画像"];

function wordToJaTag(word: string, index: number): string {
  const key = word.toLowerCase().replace(/[^a-z]/g, "");
  return KEYWORD_TO_JA_TAG[key] ?? FALLBACK_JA_TAGS[index % FALLBACK_JA_TAGS.length];
}

/**
 * Deterministic mock provider for tests and Phase 10-1+ wiring (no network,
 * no real LLM). Returns a fixed-shape structured output derived from the
 * input so core validation/normalization can be exercised. Default output
 * always returns Japanese tag labels (Phase 10-5C) — never raw English
 * words — matching the app's Japanese-first tag policy even before a real
 * provider is connected. Real OpenAI/Gemini provider is a later phase.
 */
export function createMockProvider(
  output?: unknown,
  modelId = "mock",
): PromptAnalysisProvider {
  return {
    modelId,
    analyze: async (text: string) => {
      if (output !== undefined) return output;
      // Default plausible output; Japanese tags derived from the first few words.
      const words = text.split(/\s+/).filter(Boolean).slice(0, 3);
      const jaTags = Array.from(new Set(words.map((w, i) => wordToJaTag(w, i))));
      return {
        tags: jaTags.map((label) => ({ label, confidence: 0.5 })),
        keywords_ja: jaTags,
        keywords_en: [],
        usage_category: "other",
        language_detected: "ja",
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
