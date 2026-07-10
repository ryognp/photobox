// Pure helper for the AI-candidate (PENDING TagSuggestion) filter labels
// (Phase 10-9B). No Prisma, no DOM — safe on client and server. Labels are
// used verbatim as equality match against TagSuggestion.label (already
// taxonomy-normalized at analysis time, Phase 10-5E — no re-normalization).

export const MAX_SUGGESTION_LABELS = 20;

/**
 * Parses/cleans the `suggestionLabels` param (comma-separated): trim, drop
 * empties, dedupe, cap at MAX_SUGGESTION_LABELS. Accepts either a raw
 * comma-separated string (URL param) or an array (client filters).
 */
export function normalizeSuggestionLabels(input: string | string[] | null | undefined): string[] {
  const parts = Array.isArray(input) ? input : (input ?? "").split(",");
  const cleaned = parts.map((s) => s.trim()).filter((s) => s !== "");
  return Array.from(new Set(cleaned)).slice(0, MAX_SUGGESTION_LABELS);
}
