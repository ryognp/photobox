// Phase 10-5E: controlled vocabulary + refinement for AI tag candidates.
// Goal: AI tags are reusable "big-category" classification words for Gallery
// filtering — NOT free-form image descriptions. Pure (no deps), so it is
// unit-testable and applied provider-independently inside analyzePromptCore.
//
// Pipeline (see refineTagCandidates): trim → synonym-normalize → drop banned →
// drop out-of-vocabulary → dedupe → category-priority sort → mood cap (1) →
// total cap (8).
//
// The person-attribute denylist (analysisSchema.ts) is a SEPARATE safety
// filter applied BEFORE this in analyzePromptCore; this file is about tag
// QUALITY/granularity, not safety.

export type TagCategory =
  | "time"
  | "outfit"
  | "place"
  | "composition"
  | "light"
  | "subject"
  | "mood";

/**
 * Category ordering for candidate sorting (Phase 10-5E decision): time-of-day
 * / outfit / place are the strongest Gallery filters, so they rank above
 * subject (many images share "人物", weak discriminator). Lower number = higher
 * priority = earlier in the list = more likely to survive the 8-item cap.
 */
export const CATEGORY_PRIORITY: Record<TagCategory, number> = {
  time: 1,
  outfit: 2,
  place: 3,
  composition: 4,
  light: 5,
  subject: 6,
  mood: 7,
};

/**
 * Controlled vocabulary: the ONLY tag labels allowed into TagSuggestion.
 * A normalized label not present here is dropped. Extend this table (or add
 * synonyms below) to grow the vocabulary — do not loosen the out-of-vocab
 * filter. "セクシー" is intentionally excluded (subjective/unstable).
 */
export const CATEGORY_VOCAB: Record<string, TagCategory> = {
  // 時間帯
  朝: "time",
  昼: "time",
  夕方: "time",
  夜: "time",
  // 衣装
  水着: "outfit",
  ランジェリー: "outfit",
  ドレス: "outfit",
  私服: "outfit",
  スーツ: "outfit",
  制服: "outfit",
  和装: "outfit",
  部屋着: "outfit",
  コート: "outfit",
  // 場所
  海: "place",
  プール: "place",
  ビーチ: "place",
  室内: "place",
  屋外: "place",
  ベッド: "place",
  浴室: "place",
  テラス: "place",
  カフェ: "place",
  街中: "place",
  自然: "place",
  スタジオ: "place",
  ホテル: "place",
  部屋: "place",
  // 構図
  ポートレート: "composition",
  全身: "composition",
  上半身: "composition",
  横顔: "composition",
  後ろ姿: "composition",
  手元: "composition",
  クローズアップ: "composition",
  バストアップ: "composition",
  // 光・環境
  自然光: "light",
  逆光: "light",
  室内光: "light",
  暖色光: "light",
  日差し: "light",
  夕景: "light",
  // 被写体
  人物: "subject",
  料理: "subject",
  商品: "subject",
  風景: "subject",
  建物: "subject",
  小物: "subject",
  動物: "subject",
  犬: "subject",
  猫: "subject",
  // 雰囲気
  ナチュラル: "mood",
  シンプル: "mood",
  高級感: "mood",
  クール: "mood",
  リラックス: "mood",
};

/**
 * Single label → canonical vocabulary label. Applied after trim, before the
 * vocab check, so common surface variants collapse onto a controlled term.
 * Multi-concept decomposition is intentionally NOT attempted (single-label
 * dictionary only, per Phase 10-5E decision).
 */
export const SYNONYM_MAP: Record<string, string> = {
  海辺: "海",
  海岸: "海",
  ビーチサイド: "ビーチ",
  プールサイド: "プール",
  テラス席: "テラス",
  夕暮れ: "夕方",
  夕焼け: "夕方",
  夜景: "夜",
  朝焼け: "朝",
  ワンピースドレス: "ドレス",
  ビキニ: "水着",
  スイムウェア: "水着",
};

/** Exact-match banned labels (description/atmosphere words we never want). */
const BANNED_EXACT = new Set<string>([
  "素材",
  "参考画像",
  "エアリー",
  "ミニマル",
  "肌の質感",
  "柔らかな自然光",
  "テラスの背景",
  "夕暮れ時の光学用シーンの描写",
  "開放感のあるシーン",
  "透明感のある空気感",
  "ミニマルな雰囲気",
]);

/** Suffix patterns for description-style labels (〜の描写 / 〜な雰囲気 等). */
const BANNED_SUFFIX = [/の描写$/, /の背景$/, /のシーン$/, /の質感$/, /な雰囲気$/];

const MAX_TAGS = 8;
const MAX_MOOD_TAGS = 1;

/** Trims and maps a label through the synonym table (identity if no entry). */
export function normalizeTagLabel(label: string): string {
  const trimmed = label.trim();
  return SYNONYM_MAP[trimmed] ?? trimmed;
}

/** True if the label is a banned description/atmosphere phrase. */
export function isBannedTagLabel(label: string): boolean {
  const t = label.trim();
  if (t === "") return true;
  if (BANNED_EXACT.has(t)) return true;
  return BANNED_SUFFIX.some((re) => re.test(t));
}

/** Category of a controlled-vocabulary label, or undefined if out-of-vocab. */
export function getTagCategory(label: string): TagCategory | undefined {
  return CATEGORY_VOCAB[label.trim()];
}

export type RawTagCandidate = { label: string; confidence?: number };

/**
 * Refines provider tag candidates into controlled-vocabulary Gallery tags
 * (Phase 10-5E). Assumes the person-attribute denylist has ALREADY been
 * applied by the caller (analyzePromptCore). Pure & deterministic.
 */
export function refineTagCandidates(tags: RawTagCandidate[]): RawTagCandidate[] {
  const seen = new Set<string>();
  const kept: { label: string; category: TagCategory; confidence?: number }[] = [];

  for (const t of tags) {
    const label = normalizeTagLabel(t.label);
    if (isBannedTagLabel(label)) continue;
    const category = getTagCategory(label);
    if (!category) continue; // controlled vocabulary: drop out-of-vocab
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({ label, category, confidence: t.confidence });
  }

  // Stable sort by category priority (Array.sort is stable → preserves the
  // provider's ordering within a category).
  kept.sort((a, b) => CATEGORY_PRIORITY[a.category] - CATEGORY_PRIORITY[b.category]);

  // Mood cap: keep at most MAX_MOOD_TAGS mood tags.
  let moodCount = 0;
  const moodCapped = kept.filter((t) => {
    if (t.category !== "mood") return true;
    moodCount += 1;
    return moodCount <= MAX_MOOD_TAGS;
  });

  // Total cap.
  return moodCapped.slice(0, MAX_TAGS).map((t) => ({
    label: t.label,
    ...(t.confidence !== undefined ? { confidence: t.confidence } : {}),
  }));
}
