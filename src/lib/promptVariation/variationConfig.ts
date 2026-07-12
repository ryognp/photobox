// Phase 10-11B: prompt-variation configuration read from env. Mirrors
// src/lib/translation/translationConfig.ts. Consumed by the provider factory /
// budget guard. PROMPT_VARIATION_ENABLED defaults false → mock, so no real
// OpenAI call happens until an operator explicitly enables it.
import { parseNumberEnv } from "@/lib/parseNumberEnv";

export const DEFAULT_PROMPT_VARIATION_TIMEOUT_MS = 60000;
export const DEFAULT_PROMPT_VARIATION_MAX_INPUT_CHARS = 8000;
export const DEFAULT_PROMPT_VARIATION_DAILY_CALL_LIMIT = 20;

type EnvLike = Record<string, string | undefined>;

export function readVariationTimeoutMs(env: EnvLike): number {
  return parseNumberEnv(env.PROMPT_VARIATION_TIMEOUT_MS, DEFAULT_PROMPT_VARIATION_TIMEOUT_MS);
}

export function readVariationMaxInputChars(env: EnvLike): number {
  return parseNumberEnv(env.PROMPT_VARIATION_MAX_INPUT_CHARS, DEFAULT_PROMPT_VARIATION_MAX_INPUT_CHARS);
}

export function readVariationDailyCallLimit(env: EnvLike): number {
  return parseNumberEnv(env.PROMPT_VARIATION_DAILY_CALL_LIMIT, DEFAULT_PROMPT_VARIATION_DAILY_CALL_LIMIT);
}

/**
 * Prompt-variation API key: prefer a dedicated key, fall back to the shared
 * OpenAI key (matches the translation feature's decision). Returns undefined
 * when neither is set.
 */
export function resolveVariationApiKey(env: EnvLike): string | undefined {
  return env.PROMPT_VARIATION_OPENAI_API_KEY || env.OPENAI_API_KEY || undefined;
}
