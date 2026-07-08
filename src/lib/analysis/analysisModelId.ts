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
export const ANALYSIS_PROMPT_VERSION = "ja-tags-v1";

export function buildAnalysisModelId(args: {
  provider: "mock" | "openai" | "gemini";
  model: string;
  promptVersion: string;
}): string {
  return `${args.provider}:${args.model}:${args.promptVersion}`;
}
