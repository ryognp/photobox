// Phase 10-9C-2: translation configuration read from env. Mirrors
// src/lib/analysis/analysisConfig.ts. Consumed by the translation provider
// factory / budget guard. In 10-9C-2 nothing calls the provider yet
// (TRANSLATION_ENABLED defaults false → mock); the single-image translate
// route (10-9C-3) will wire these.
import { parseNumberEnv } from "@/lib/parseNumberEnv";

export const DEFAULT_TRANSLATION_TIMEOUT_MS = 60000;
export const DEFAULT_TRANSLATION_MAX_INPUT_CHARS = 8000;
export const DEFAULT_TRANSLATION_DAILY_CALL_LIMIT = 20;

type EnvLike = Record<string, string | undefined>;

export function readTranslationTimeoutMs(env: EnvLike): number {
  return parseNumberEnv(env.TRANSLATION_TIMEOUT_MS, DEFAULT_TRANSLATION_TIMEOUT_MS);
}

export function readTranslationMaxInputChars(env: EnvLike): number {
  return parseNumberEnv(env.TRANSLATION_MAX_INPUT_CHARS, DEFAULT_TRANSLATION_MAX_INPUT_CHARS);
}

export function readTranslationDailyCallLimit(env: EnvLike): number {
  return parseNumberEnv(env.TRANSLATION_DAILY_CALL_LIMIT, DEFAULT_TRANSLATION_DAILY_CALL_LIMIT);
}

/**
 * Translation API key: prefer a dedicated key, fall back to the shared OpenAI
 * key (Phase 10-9C-2 decision). Returns undefined when neither is set.
 */
export function resolveTranslationApiKey(env: EnvLike): string | undefined {
  return env.TRANSLATION_OPENAI_API_KEY || env.OPENAI_API_KEY || undefined;
}
