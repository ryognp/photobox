// Phase 10-11B: prompt-variation run-spec identifier. Mirrors
// src/lib/analysis/analysisModelId.ts / translationModelId.ts — provider +
// model + promptVersion, so changing the system prompt's meaning changes the
// modelId (used in the budget Redis key; no cache table here since nothing is
// persisted, but the composite id keeps budget buckets separated per prompt
// version, matching the other features).
//
// Bump PROMPT_VARIATION_PROMPT_VERSION when the system prompt's meaning changes.
export const PROMPT_VARIATION_PROMPT_VERSION = "prompt-var-v1";

export function buildVariationModelId(args: {
  provider: "mock" | "openai";
  model: string;
  promptVersion: string;
}): string {
  return `${args.provider}:${args.model}:${args.promptVersion}`;
}
