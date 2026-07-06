import { z } from "zod";

/** Current analysis output schema version. Bump when the shape/semantics change. */
export const PROMPT_ANALYSIS_SCHEMA_VERSION = "prompt-v1";

/** Allowed usage categories. Unknown values are coerced to "other". */
export const USAGE_CATEGORIES = [
  "portrait",
  "character_reference",
  "scene_reference",
  "style_reference",
  "product",
  "background",
  "social_post",
  "document_or_screenshot",
  "other",
] as const;
export type UsageCategory = (typeof USAGE_CATEGORIES)[number];

/**
 * Provider output schema. `.catch()` makes unknown enum values safe rather
 * than failing the whole parse.
 */
export const promptAnalysisSchema = z.object({
  tags: z
    .array(
      z.object({
        label: z.string().min(1).max(40),
        confidence: z.number().min(0).max(1).optional(),
      }),
    )
    .max(15),
  keywords_ja: z.array(z.string().min(1).max(40)).max(20),
  keywords_en: z.array(z.string().min(1).max(40)).max(20),
  usage_category: z.enum(USAGE_CATEGORIES).catch("other"),
  language_detected: z.enum(["ja", "en", "mixed"]).catch("mixed"),
});

export type PromptAnalysisOutput = z.infer<typeof promptAnalysisSchema>;

/**
 * Denylist for person-attribute inference (defense-in-depth alongside the
 * system prompt). We do NOT emit tags/keywords about age, gender, race,
 * identity, health, religion, etc. A term is dropped if any denylist entry is
 * a whole-word (case-insensitive) match. This is intentionally conservative;
 * it is a safety filter, not a classifier.
 */
export const ATTRIBUTE_DENYLIST: string[] = [
  // age
  "age", "aged", "year old", "years old", "minor", "underage", "teen", "teenager", "child", "kid", "elderly", "old man", "old woman",
  "年齢", "歳", "未成年", "少年", "少女", "子供", "高齢",
  // gender / sex
  "gender", "male", "female", "man", "woman", "boy", "girl", "transgender", "nonbinary",
  "性別", "男性", "女性", "男", "女",
  // race / ethnicity / nationality-as-attribute
  "race", "ethnicity", "ethnic", "asian", "white", "black", "caucasian", "hispanic", "latino", "african", "skin color", "skin tone",
  "人種", "民族", "肌の色",
  // identity / health / religion / orientation
  "identity", "real name", "identify", "health", "disease", "disability", "pregnant", "religion", "religious", "sexual orientation", "gay", "lesbian",
  "本名", "宗教", "病気", "妊娠", "障害", "性的指向",
];

/** True if `term` matches any denylist entry as a whole word (case-insensitive). */
export function isAttributeTerm(term: string): boolean {
  const t = term.trim().toLowerCase();
  if (!t) return false;
  return ATTRIBUTE_DENYLIST.some((banned) => {
    const b = banned.toLowerCase();
    if (t === b) return true;
    // whole-word / phrase boundary check for latin; substring for CJK (no word boundaries)
    if (/[a-z]/.test(b)) {
      const re = new RegExp(`(^|[^a-z])${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i");
      return re.test(t);
    }
    return t.includes(b);
  });
}

/** Drops any string that matches the attribute denylist. */
export function filterAttributeTerms(terms: string[]): string[] {
  return terms.filter((term) => !isAttributeTerm(term));
}
