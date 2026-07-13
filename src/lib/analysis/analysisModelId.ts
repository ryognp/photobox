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
// ja-tags-v4 (Phase 10-10B): removed the ambiguous "golden hour" -> 夕方
// mapping (it caused morning photos to be mistagged 夕方); golden hour now
// requires an accompanying morning/evening word to resolve a time-of-day tag,
// and bare light-quality words (warm/golden/soft/natural light) never yield a
// time-of-day tag. Same reasoning as v3: this changes analysis output
// meaning, so the version bump is required.
// ja-tags-v5 (Phase 10-10C): v4's blanket "output only when unambiguous /
// omit when uncertain" instruction, sitting right next to the golden-hour
// caveat, apparently suppressed recall for the WHOLE time-of-day category —
// clear signals like morning/sunrise stopped producing a tag too. v5 restores
// "always output a tag when a clear time word (morning/sunrise/evening/
// sunset/etc.) is present" as the default, and narrows the "omit if uncertain"
// caveat to ONLY the ambiguous terms (golden hour alone, bare light-quality
// words). Changes analysis output meaning, so the version bump is required.
// ja-tags-v6 (Phase 10-13C): removed 7 generic/abstract/low-value labels from
// CATEGORY_VOCAB based on real-world usage feedback — 私服 (outfit),
// 室内/屋外 (place), 自然光 (light), ナチュラル/シンプル/リラックス (mood).
// system prompt updated to instruct preferring specific labels (部屋/ホテル/
// スタジオ/カフェ over 室内; 海/プール/ビーチ/街中/自然/テラス over 屋外) and
// to explicitly list the removed labels as "do not output". Same reasoning as
// v3/v4/v5: this changes analysis output meaning, so the version bump is
// required — old ja-tags-v5 PENDING TagSuggestions are left in the DB
// untouched (per Phase 10-13B, the current-version display filter already
// hides any PENDING suggestion whose modelId doesn't end with the current
// promptVersion, so v5 candidates simply stop appearing without any DB
// UPDATE/DELETE).
export const ANALYSIS_PROMPT_VERSION = "ja-tags-v6";

export function buildAnalysisModelId(args: {
  provider: "mock" | "openai" | "gemini";
  model: string;
  promptVersion: string;
}): string {
  return `${args.provider}:${args.model}:${args.promptVersion}`;
}
