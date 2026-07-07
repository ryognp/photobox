// Pure logic for Prompt Japanese-translation caching (Phase 10-5B). No Prisma
// import, no server-only — DB/route wiring lives in reserveTranslationTargets
// and the route layer. Mirrors src/lib/analysis/analyzePromptCore.ts's
// "pure + DI core" pattern.
import { createHash } from "node:crypto";

/** Hiragana / Katakana / Kanji ranges. One match is enough to call it Japanese. */
const JA_PATTERN = /[぀-ゟ゠-ヿ一-鿿]/;

export function isJapaneseText(text: string): boolean {
  return JA_PATTERN.test(text);
}

/** SHA-256 hex of the normalized (whitespace-collapsed, trimmed) body. */
export function computeBodyHash(body: string): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex");
}

export type TranslationStatus = "NONE" | "PENDING" | "DONE" | "FAILED" | "SKIPPED_ALREADY_JA";

export type TranslationTargetInput = {
  currentBody: string;
  translationStatus: TranslationStatus;
  translatedFromBodyHash: string | null;
  force: boolean;
};

export type TranslationTargetDecision =
  | { action: "skip_already_ja"; bodyHash: string }
  | { action: "skip_cached"; bodyHash: string }
  | { action: "translate"; bodyHash: string };

/**
 * Decides what to do with a single prompt during a translation batch run.
 * Japanese text is skipped even when `force` is set — force only means
 * "ignore the existing DONE cache", never "translate Japanese text".
 */
export function decideTranslationTarget(input: TranslationTargetInput): TranslationTargetDecision {
  const bodyHash = computeBodyHash(input.currentBody);

  if (isJapaneseText(input.currentBody)) {
    return { action: "skip_already_ja", bodyHash };
  }

  if (
    !input.force &&
    input.translationStatus === "DONE" &&
    input.translatedFromBodyHash === bodyHash
  ) {
    return { action: "skip_cached", bodyHash };
  }

  return { action: "translate", bodyHash };
}

/**
 * Returns the Japanese body to use for downstream consumers (e.g. Phase
 * 10-5C's analyze input), or null if there is no trustworthy translation.
 * Never returns translatedBodyJa on presence alone — status AND hash must
 * both match the current currentBody, so a stale translation (from before a
 * currentBody edit) is never used.
 */
export function getEffectiveJapanesePromptBody(prompt: {
  currentBody: string;
  translatedBodyJa: string | null;
  translatedFromBodyHash: string | null;
  translationStatus: TranslationStatus;
}): string | null {
  const currentHash = computeBodyHash(prompt.currentBody);

  if (
    (prompt.translationStatus === "DONE" || prompt.translationStatus === "SKIPPED_ALREADY_JA") &&
    prompt.translatedBodyJa != null &&
    prompt.translatedBodyJa.trim() !== "" &&
    prompt.translatedFromBodyHash === currentHash
  ) {
    return prompt.translatedBodyJa;
  }

  return null;
}

/**
 * Data fragment to merge into any Prisma `prompt.update({ data: ... })` call
 * that changes `currentBody`. Every such call site MUST spread this in, or a
 * stale translation could be served after the body changes underneath it.
 */
export function resetTranslationCacheData(): {
  translatedBodyJa: null;
  translatedFromBodyHash: null;
  translationStatus: "NONE";
  translationProvider: null;
  translationModel: null;
  translatedAt: null;
  translationStartedAt: null;
  translationError: null;
} {
  return {
    translatedBodyJa: null,
    translatedFromBodyHash: null,
    translationStatus: "NONE",
    translationProvider: null,
    translationModel: null,
    translatedAt: null,
    translationStartedAt: null,
    translationError: null,
  };
}

const API_KEY_PATTERN = /sk-[A-Za-z0-9_-]+/g;
const MAX_ERROR_LENGTH = 500;

/** Strips likely API keys and caps length before persisting/returning an error. */
export function sanitizeTranslationError(e: unknown): string {
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : "translation failed";
  return message.replace(API_KEY_PATTERN, "[REDACTED_API_KEY]").slice(0, MAX_ERROR_LENGTH);
}
