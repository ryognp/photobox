// Phase 10-5D: normalizes an analysis error into a short, safe string before
// it is stored on ImageAnalysis.error or returned in the API response. Mirrors
// src/lib/translation/translationCore.ts's sanitizeTranslationError — strips
// likely API keys and caps length so a real provider's error (which may embed
// secrets or huge payloads) never leaks to the DB or client.
const API_KEY_PATTERN = /sk-[A-Za-z0-9_-]+/g;
const MAX_ERROR_LENGTH = 500;

export function sanitizeAnalysisError(e: unknown): string {
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : "analysis failed";
  return message.replace(API_KEY_PATTERN, "[REDACTED_API_KEY]").slice(0, MAX_ERROR_LENGTH);
}
