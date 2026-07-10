// Phase 10-9C-5: detects when the translation provider returned a refusal /
// apology instead of a translation (it comes back as normal output_text, so it
// would otherwise be saved as a DONE translation). Pure + client-safe — NO
// node:crypto / server-only / Prisma. Deliberately CONSERVATIVE: a phrase must
// begin the output, or the whole output must be short AND contain the phrase.
// Merely containing an apology inside a long, real translation must NOT match.

/** Lowercased, straight-apostrophe refusal phrases (JA + EN). */
const REFUSAL_PHRASES = [
  // Japanese
  "申し訳ございません",
  "申し訳ありません",
  "お応えできません",
  "対応できません",
  "翻訳できません",
  // English
  "i'm sorry",
  "i am sorry",
  "i can't assist",
  "i cannot assist",
  "i can't help",
  "i can't comply",
  "cannot comply",
  "unable to help",
];

/** Above this length, only a leading refusal phrase counts (avoids matching an
 *  apology that legitimately appears inside a long translation). */
const SHORT_TEXT_MAX = 120;

/** trim → lowercase → normalize curly apostrophes to straight (OpenAI often
 *  emits "I'm"/"can't" with U+2019). */
function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/[‘’]/g, "'");
}

/**
 * True when `text` looks like a provider refusal rather than a translation.
 * - starts with a refusal phrase (covers long, multi-sentence refusals), OR
 * - is short (<= SHORT_TEXT_MAX) AND contains a refusal phrase.
 */
export function looksLikeTranslationRefusal(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;

  const normalized = normalize(trimmed);

  for (const phrase of REFUSAL_PHRASES) {
    if (normalized.startsWith(phrase)) return true;
  }

  if (trimmed.length <= SHORT_TEXT_MAX) {
    for (const phrase of REFUSAL_PHRASES) {
      if (normalized.includes(phrase)) return true;
    }
  }

  return false;
}

/** Stored on Prompt.translationError and returned when a refusal is detected. */
export const TRANSLATION_REFUSED_ERROR = "translation provider refused";
