// Phase 10-9C-5: detects when the translation provider returned a refusal /
// apology instead of a translation (it comes back as normal output_text, so it
// would otherwise be saved as a DONE translation). Pure + client-safe — NO
// node:crypto / server-only / Prisma. Deliberately CONSERVATIVE: only text that
// BEGINS with a refusal phrase counts. Merely containing a phrase anywhere —
// even in a short output — must NOT match, because generic verbs like
// 「対応できません」/「翻訳できません」 legitimately appear inside real
// translations (e.g. 「この形式には対応できません。」).

/** Lowercased, straight-apostrophe refusal phrases (JA + EN). Matched at the
 *  START of the output only. */
const REFUSAL_PHRASES = [
  // Japanese — refusals open with the apology/denial itself
  "申し訳ございません",
  "申し訳ありません",
  "お応えできません",
  "対応できません",
  "翻訳できません",
  // English — cover both contracted and full forms so leading-match holds
  "i'm sorry",
  "i am sorry",
  "i can't assist",
  "i cannot assist",
  "i can't help",
  "i cannot help",
  "i can't comply",
  "i cannot comply",
  "cannot comply",
  "unable to help",
];

/** trim → lowercase → normalize curly apostrophes to straight (OpenAI often
 *  emits "I'm"/"can't" with U+2019). */
function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/[‘’]/g, "'");
}

/**
 * True when `text` looks like a provider refusal rather than a translation:
 * the output STARTS with a known refusal phrase. No contains-anywhere matching
 * (avoids false positives on real translations that mention e.g.
 * 「〜には対応できません」 mid-sentence). An output that IS exactly a refusal
 * phrase (± trailing punctuation) also starts with it, so it matches too.
 */
export function looksLikeTranslationRefusal(text: string): boolean {
  const normalized = normalize(text);
  if (normalized === "") return false;

  for (const phrase of REFUSAL_PHRASES) {
    if (normalized.startsWith(phrase)) return true;
  }

  return false;
}

/** Stored on Prompt.translationError and returned when a refusal is detected. */
export const TRANSLATION_REFUSED_ERROR = "translation provider refused";
