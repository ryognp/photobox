// Phase 10-9C-2: translation run-spec identifier, stored on
// Prompt.translationModel and used in the budget Redis key. Mirrors
// src/lib/analysis/analysisModelId.ts — provider + model + promptVersion, so
// changing the translation system prompt busts nothing silently (bump the
// version and the modelId changes).
//
// Bump TRANSLATION_PROMPT_VERSION when the translation system prompt's meaning
// changes.
export const TRANSLATION_PROMPT_VERSION = "tr-v1";

export function buildTranslationModelId(args: {
  provider: "mock" | "openai";
  model: string;
  promptVersion: string;
}): string {
  return `${args.provider}:${args.model}:${args.promptVersion}`;
}
