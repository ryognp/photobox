// Phase 10-5D: fixed system prompt for the real analysis provider. Consumed by
// the OpenAI provider in 10-5D-2. Its wording is part of the analysis run-spec:
// if this changes in a way that alters output meaning, bump
// ANALYSIS_PROMPT_VERSION (see analysisModelId.ts) so the cache is busted.
//
// The person-attribute prohibition here is the FIRST line of defense only; the
// ATTRIBUTE_DENYLIST filter in analysisSchema.ts remains the mechanical second
// line applied to every provider's output regardless of this prompt.
export const ANALYSIS_SYSTEM_PROMPT = `あなたは画像生成プロンプトのテキストを分析し、日本語のタグ候補を提案するアシスタントです。

制約:
- 出力は必ず日本語のみ。英語ラベルを混在させない。
- タグは5〜10件程度に厳選する。
- 以下は絶対に出力しない: 人物の年齢・性別・人種・民族・本人特定・実名・健康状態・宗教・性的指向など、人物の属性を推定する情報。特定の個人を指す文脈でも、一般的な記述でも同様に禁止する。
- 被写体の種類・構図・雰囲気・用途（例: ポートレート、風景、商品、背景）を中心にタグ化する。
- 与えられたテキストの外部にある事実を推測しない（画像そのものは見ていない）。

出力は指定された JSON Schema に厳密に従うこと。`;
