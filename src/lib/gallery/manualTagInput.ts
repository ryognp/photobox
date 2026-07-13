// Pure validation/normalization for manually-typed tag names (Phase 10-16B).
// Kept separate from src/lib/analysis/suggestionTransition.ts's
// validateSuggestionLabel — that helper is scoped to AI TagSuggestion
// edit-and-approve and importing it here would couple the gallery manual-tag
// feature to the analysis module for no real benefit. The 40-char limit is
// kept in sync with LABEL_MAX_LENGTH there because Tag.name is a single
// shared namespace (@@unique([workspaceId, name])) for both AI-approved and
// manually-typed tags — but SYNONYM_MAP/taxonomy normalization from
// tagTaxonomy.ts is intentionally NOT applied here: a manually-typed tag is
// an explicit user label, not an AI candidate to be normalized.

export const MANUAL_TAG_NAME_MAX_LENGTH = 40;

export type NormalizeManualTagNameResult =
  | { ok: true; name: string }
  | { ok: false; error: string };

/** Trims a manually-typed tag name and validates it. No synonym/taxonomy
 *  normalization — the trimmed input is used verbatim. */
export function normalizeManualTagName(name: unknown): NormalizeManualTagNameResult {
  if (typeof name !== "string") return { ok: false, error: "name must be a string" };

  const trimmed = name.trim();
  if (trimmed === "") return { ok: false, error: "name is required" };

  if (trimmed.length > MANUAL_TAG_NAME_MAX_LENGTH) {
    return { ok: false, error: `name must be at most ${MANUAL_TAG_NAME_MAX_LENGTH} characters` };
  }

  return { ok: true, name: trimmed };
}
