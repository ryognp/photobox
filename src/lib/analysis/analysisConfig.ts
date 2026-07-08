// Phase 10-5D: analysis configuration read from env, plus input truncation.
// In 10-5D-1 only maxInputChars is consumed (by the analyze route). timeoutMs
// and dailyCallLimit readers are provided now so 10-5D-2 (OpenAI provider +
// cost guard) can wire them without re-touching config plumbing.
import { parseNumberEnv } from "@/lib/parseNumberEnv";

export const DEFAULT_ANALYSIS_MAX_INPUT_CHARS = 8000;
export const DEFAULT_ANALYSIS_TIMEOUT_MS = 20000;
export const DEFAULT_ANALYSIS_DAILY_CALL_LIMIT = 100;

type EnvLike = Record<string, string | undefined>;

export function readAnalysisMaxInputChars(env: EnvLike): number {
  return parseNumberEnv(env.AI_ANALYSIS_MAX_INPUT_CHARS, DEFAULT_ANALYSIS_MAX_INPUT_CHARS);
}

export function readAnalysisTimeoutMs(env: EnvLike): number {
  return parseNumberEnv(env.AI_ANALYSIS_TIMEOUT_MS, DEFAULT_ANALYSIS_TIMEOUT_MS);
}

export function readAnalysisDailyCallLimit(env: EnvLike): number {
  return parseNumberEnv(env.AI_ANALYSIS_DAILY_CALL_LIMIT, DEFAULT_ANALYSIS_DAILY_CALL_LIMIT);
}

/**
 * Caps the text sent to the analysis provider (and hashed for caching). The
 * truncated text — not the original — must be what both computePromptHash and
 * provider.analyze see, so the cache key matches what was actually analyzed.
 */
export function truncateAnalysisInput(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars)}\n\n[入力が長いためここで切り詰めました]`,
    truncated: true,
  };
}
