// Pure persistence planning for prompt analysis (Phase 10-2). No Prisma import
// so it stays unit-testable; the route maps the plan to actual DB writes inside
// a transaction. Decides cached vs re-analyze, and what to persist per status.
import type { AnalyzePromptResult } from "./analyzePromptCore";

export type ExistingAnalysis = {
  status: "PENDING" | "DONE" | "FAILED" | "SKIPPED_NO_PROMPT";
  promptHash: string | null;
} | null;

/**
 * Whether the existing analysis can be returned without re-running.
 * - force → never cached
 * - no existing → not cached
 * - current input has NO prompt → cached iff existing is SKIPPED_NO_PROMPT
 * - current input HAS prompt → cached iff existing is DONE and promptHash matches
 */
export function isAnalysisCached(args: {
  existing: ExistingAnalysis;
  currentHasPrompt: boolean;
  currentPromptHash: string | null;
  force: boolean;
}): boolean {
  if (args.force) return false;
  if (!args.existing) return false;
  if (!args.currentHasPrompt) {
    return args.existing.status === "SKIPPED_NO_PROMPT";
  }
  return args.existing.status === "DONE" && args.existing.promptHash === args.currentPromptHash;
}

export type AnalysisPersistencePlan = {
  status: "DONE" | "FAILED" | "SKIPPED_NO_PROMPT";
  promptHash: string | null;
  error: string | null;
  usageCategory: string | null;
  languageDetected: string | null;
  /** provider structured output (DONE) or raw invalid output (FAILED); null otherwise. */
  raw: unknown | null;
  keywordsJa: string[] | null;
  keywordsEn: string[] | null;
  /** DONE / SKIPPED reset PENDING suggestions (keep APPROVED/REJECTED); FAILED does not touch them. */
  resetPendingSuggestions: boolean;
  suggestionRows: { label: string; confidence: number | null }[];
};

/** Maps a core result into a persistence plan (pure). */
export function planPersistence(result: AnalyzePromptResult): AnalysisPersistencePlan {
  if (result.status === "SKIPPED_NO_PROMPT") {
    return {
      status: "SKIPPED_NO_PROMPT",
      promptHash: null,
      error: null,
      usageCategory: null,
      languageDetected: null,
      raw: null,
      keywordsJa: null,
      keywordsEn: null,
      resetPendingSuggestions: true,
      suggestionRows: [],
    };
  }

  if (result.status === "FAILED") {
    return {
      status: "FAILED",
      promptHash: result.promptHash,
      error: result.error,
      usageCategory: null,
      languageDetected: null,
      raw: result.raw ?? null,
      keywordsJa: null,
      keywordsEn: null,
      resetPendingSuggestions: false, // leave existing suggestions untouched
      suggestionRows: [],
    };
  }

  // DONE
  return {
    status: "DONE",
    promptHash: result.promptHash,
    error: null,
    usageCategory: result.usageCategory,
    languageDetected: result.languageDetected,
    raw: result.raw ?? null,
    keywordsJa: result.keywordsJa,
    keywordsEn: result.keywordsEn,
    resetPendingSuggestions: true,
    suggestionRows: result.tags.map((t) => ({
      label: t.label,
      confidence: t.confidence ?? null,
    })),
  };
}
