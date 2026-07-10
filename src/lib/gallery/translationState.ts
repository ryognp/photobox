// Phase 10-9C-4: pure reducer helpers for translation-related detail updates.
// Client-safe — NO node:crypto / server-only (mirrors tagState.ts). The server
// owns hash-based "effective" computation; these helpers only fold API results
// and prompt edits back into the already-fetched ImageDetail.
import type { ImageDetail, TranslatePromptResult } from "@/lib/gallery/imagesClient";

type DetailPrompt = NonNullable<ImageDetail["prompt"]>;

/**
 * Folds a translate-prompt API result into the detail. Only DONE /
 * SKIPPED_ALREADY_JA yield a fresh effective translation (the server just
 * translated from the current body). FAILED / stale / disabled / no_prompt keep
 * the previously displayed effective translation — matching the server, which
 * never overwrites translatedBodyJa on FAILED.
 */
export function applyTranslationUpdate(detail: ImageDetail, result: TranslatePromptResult): ImageDetail {
  if (!detail.prompt) return detail;
  const t = result.translation;

  const effective =
    (result.status === "DONE" || result.status === "SKIPPED_ALREADY_JA") && t != null
      ? t.translatedBodyJa
      : detail.prompt.effectiveTranslatedBodyJa;

  // Mirror raw translation fields when the server returned them, so detail state
  // stays consistent. Display still reads effectiveTranslatedBodyJa only.
  const prompt: DetailPrompt =
    t != null
      ? {
          ...detail.prompt,
          translatedBodyJa: t.translatedBodyJa,
          translationStatus: t.translationStatus,
          translationProvider: t.translationProvider,
          translationModel: t.translationModel,
          translatedAt: t.translatedAt,
          translationError: t.translationError,
          effectiveTranslatedBodyJa: effective,
        }
      : { ...detail.prompt, effectiveTranslatedBodyJa: effective };

  return { ...detail, prompt };
}

/**
 * Merges a saved prompt (from PATCH /prompt, which returns only
 * id/originalBody/currentBody/versions) into the previous detail prompt. When
 * currentBody changed, the cached translation is stale, so it is cleared —
 * client-side mirror of the server's resetTranslationCacheData (which we cannot
 * import here: it lives in translationCore.ts alongside node:crypto).
 */
export function applyPromptEditToDetailPrompt(prev: DetailPrompt, saved: DetailPrompt): DetailPrompt {
  const merged: DetailPrompt = { ...prev, ...saved };
  if (saved.currentBody === prev.currentBody) return merged;
  return {
    ...merged,
    translatedBodyJa: null,
    translatedFromBodyHash: null,
    translationStatus: "NONE",
    translationProvider: null,
    translationModel: null,
    translatedAt: null,
    translationStartedAt: null,
    translationError: null,
    effectiveTranslatedBodyJa: null,
  };
}
