// Phase 10-13B: pure display-filter for AI tag suggestions. Bumping
// ANALYSIS_PROMPT_VERSION (see analysisModelId.ts) creates a NEW ImageAnalysis
// row per image ([imageId, source, modelId, schemaVersion] is unique) — the
// OLD ImageAnalysis row and its PENDING TagSuggestions are left in the DB
// untouched, forever, by design (never deleted, never updated). Before this
// phase, both GET /api/images/[id] and GET /api/tag-suggestions displayed
// EVERY PENDING TagSuggestion regardless of which prompt version produced it
// — so tag-quality improvements from later phases (10-10A/B/C) were invisible
// because old, lower-quality candidates kept showing up alongside them.
//
// This file adds a READ-ONLY display filter: only PENDING suggestions whose
// ImageAnalysis.modelId belongs to the CURRENT ANALYSIS_PROMPT_VERSION are
// shown. Nothing here writes to the DB — old rows are left exactly where they
// are; a user can still see/approve/reject them via the per-suggestion API
// if they navigate to them some other way (untouched — see approve/reject
// routes, not modified by this phase). APPROVED suggestions and their
// resulting ImageTag rows are entirely unaffected: this filter only ever
// touches the PENDING-suggestion query the caller already restricts to
// `status: "PENDING"`.
//
// This is a SEPARATE layer from isExcludedGenericLabel (tagTaxonomy.ts), which
// hides specific labels (人物/ポートレート) regardless of prompt version. Both
// filters are typically applied together by the callers (see route.ts files).
import { ANALYSIS_PROMPT_VERSION } from "./analysisModelId";

/**
 * `ImageAnalysis.modelId` is `provider:model:promptVersion` (see
 * buildAnalysisModelId in analysisModelId.ts). This returns the suffix
 * (":ja-tags-v5", including the leading colon) that marks a modelId as
 * belonging to the CURRENT prompt version — matched by suffix rather than the
 * full composite id so provider/model differences (mock vs openai, model
 * swaps, Preview vs Production env) don't affect whether a suggestion counts
 * as "current"; only the prompt version matters for this filter's purpose.
 */
export function getCurrentAnalysisModelIdSuffix(): string {
  return `:${ANALYSIS_PROMPT_VERSION}`;
}

/** True when `modelId` belongs to the current ANALYSIS_PROMPT_VERSION (suffix
 *  match). False for null/undefined/mismatched modelIds — a suggestion with no
 *  resolvable modelId is treated as NOT current (safer default: hide rather
 *  than show a candidate of unknown provenance). */
export function isCurrentAnalysisModelId(modelId: string | null | undefined): boolean {
  if (modelId == null) return false;
  return modelId.endsWith(getCurrentAnalysisModelIdSuffix());
}

/**
 * Minimal shape a caller needs to attach to each PENDING suggestion so this
 * filter can judge it — just the modelId of the ImageAnalysis it belongs to
 * (never expose the full ImageAnalysis object to the API response; the route
 * layer should select only `analysis: { select: { modelId: true } }` and drop
 * it after filtering).
 */
export type SuggestionWithAnalysisModelId = {
  analysis?: { modelId: string | null } | null;
};

/**
 * Filters a list of PENDING suggestions down to only those produced by the
 * CURRENT ANALYSIS_PROMPT_VERSION. A suggestion whose `analysis` is
 * null/missing (should not normally happen — analysisId is a required FK) is
 * dropped rather than shown, matching isCurrentAnalysisModelId's safe default.
 * Pure — does not mutate the input array or its items.
 */
export function filterCurrentVersionPendingSuggestions<T extends SuggestionWithAnalysisModelId>(
  suggestions: T[],
): T[] {
  return suggestions.filter((s) => isCurrentAnalysisModelId(s.analysis?.modelId));
}
