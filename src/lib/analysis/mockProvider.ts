import type { PromptAnalysisProvider } from "./provider";

/**
 * English keyword → controlled-vocabulary Japanese tag (Phase 10-5E). Values
 * are drawn from tagTaxonomy's CATEGORY_VOCAB so mock output survives the
 * refinement pipeline. NOT translation logic — a small fixed lookup so mock
 * candidates are realistic. Unmapped words yield NO tag (Phase 10-5E: the old
 * "素材"/"参考画像" fallback was removed — 0 candidates is acceptable rather
 * than emitting non-reusable filler). A real provider generates genuine
 * Japanese labels via its own prompt/schema.
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
  landscape: "風景",
  mountain: "風景",
  ocean: "海",
  sea: "海",
  beach: "ビーチ",
  city: "街中",
  street: "街中",
  indoor: "室内",
  outdoor: "屋外",
  studio: "スタジオ",
  hotel: "ホテル",
  pool: "プール",
  dress: "ドレス",
  suit: "スーツ",
};

/** Maps a word to a controlled-vocab tag, or null if unmapped (no fallback). */
function wordToJaTag(word: string): string | null {
  const key = word.toLowerCase().replace(/[^a-z]/g, "");
  return KEYWORD_TO_JA_TAG[key] ?? null;
}

/**
 * Deterministic mock provider for tests and non-OpenAI wiring (no network,
 * no real LLM). Returns a fixed-shape structured output derived from the
 * input. Default output returns controlled-vocabulary Japanese tags only
 * (Phase 10-5E); unmapped input yields 0 tags rather than filler. Real
 * OpenAI/Gemini provider is wired separately.
 */
export function createMockProvider(
  output?: unknown,
  modelId = "mock",
): PromptAnalysisProvider {
  return {
    modelId,
    analyze: async (text: string) => {
      if (output !== undefined) return output;
      // Default plausible output; controlled-vocab tags from matched words.
      const words = text.split(/\s+/).filter(Boolean).slice(0, 8);
      const jaTags = Array.from(
        new Set(words.map((w) => wordToJaTag(w)).filter((t): t is string => t !== null)),
      );
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
