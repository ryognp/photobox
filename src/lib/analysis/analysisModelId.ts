// Phase 10-5D: analysis run-spec identifier. The value stored on
// ImageAnalysis.modelId is NOT a bare model name — it is provider + model +
// promptVersion, so that changing the system prompt / JSON schema semantics
// (which a bare model name would not reflect) busts the analysis cache
// (ImageAnalysis unique key is [imageId, source, modelId, schemaVersion]).
//
// Bump ANALYSIS_PROMPT_VERSION whenever the system prompt, the output JSON
// schema's meaning, the usage-category policy, or the person-attribute
// prohibition wording changes — old DONE analyses then live under a different
// modelId and are never returned as `cached`.
// ja-tags-v3 (Phase 10-10A): removed 人物/ポートレート from the vocabulary +
// system prompt (too generic for Photo.box), strengthened time-of-day
// detection (English term examples, "output the JA tag even if only the
// English term is present"). This changes analysis output meaning, so the
// version bump is required — verified: the analyze route looks up existing
// ImageAnalysis by the composite unique key [imageId, source, modelId,
// schemaVersion] (see analyze/route.ts), and modelId embeds promptVersion via
// buildAnalysisModelId — so a version bump alone changes modelId and correctly
// misses the old v2 row, forcing re-analysis on next access (old v2 rows are
// left in place, not deleted).
export const ANALYSIS_PROMPT_VERSION = "ja-tags-v3";

export function buildAnalysisModelId(args: {
  provider: "mock" | "openai" | "gemini";
  model: string;
  promptVersion: string;
}): string {
  return `${args.provider}:${args.model}:${args.promptVersion}`;
}
