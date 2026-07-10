// Phase 10-9C-3: pure helpers for the single-image prompt translation route.
// No Prisma runtime, no DB, no server-only — unit-testable. The route wires
// these to resolveWorkspaceImage + provider + guarded updateMany.
import type { Prisma } from "@/generated/prisma/client";

/**
 * Caps the text sent to the translation provider. IMPORTANT: this affects ONLY
 * the provider input — the persisted `translatedFromBodyHash` must remain the
 * hash of the FULL currentBody (so getEffectiveJapanesePromptBody's cache check
 * still matches). Mirrors analysisConfig.truncateAnalysisInput.
 */
export function truncateTranslationInput(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}\n\n[入力が長いためここで切り詰めました]`, truncated: true };
}

export type TranslationUpdateOutcome =
  | { kind: "done"; translatedText: string; bodyHash: string; providerId: string; modelId: string }
  | { kind: "skipped_already_ja"; currentBody: string; bodyHash: string }
  | { kind: "failed"; error: string; providerId: string | null; modelId: string | null };

/**
 * Builds the Prisma update data for a single prompt translation outcome.
 * NEVER includes currentBody / originalBody — the original English prompt is
 * immutable. On FAILED, translatedBodyJa is intentionally left out so any
 * previous translation is preserved (not overwritten with null).
 */
export function buildTranslationUpdateData(
  outcome: TranslationUpdateOutcome,
  now: Date,
): Prisma.PromptUpdateManyMutationInput {
  switch (outcome.kind) {
    case "done":
      return {
        translationStatus: "DONE",
        translatedBodyJa: outcome.translatedText,
        translatedFromBodyHash: outcome.bodyHash,
        translationProvider: outcome.providerId,
        translationModel: outcome.modelId,
        translatedAt: now,
        translationStartedAt: null,
        translationError: null,
      };
    case "skipped_already_ja":
      return {
        translationStatus: "SKIPPED_ALREADY_JA",
        // Already-Japanese body is stored verbatim as the "translation" so
        // getEffectiveJapanesePromptBody returns it (Phase 10-5B convention).
        translatedBodyJa: outcome.currentBody,
        translatedFromBodyHash: outcome.bodyHash,
        translationProvider: null,
        translationModel: null,
        translatedAt: now,
        translationStartedAt: null,
        translationError: null,
      };
    case "failed":
      return {
        translationStatus: "FAILED",
        translationProvider: outcome.providerId,
        translationModel: outcome.modelId,
        translationStartedAt: null,
        translationError: outcome.error,
        // translatedBodyJa deliberately omitted — keep any prior translation.
      };
  }
}
