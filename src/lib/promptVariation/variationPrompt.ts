// Phase 10-11B: fixed system prompt for the prompt-variation generator.
// Consumed by the OpenAI provider. Its wording is part of the run-spec: if it
// changes in a way that alters output meaning, bump
// PROMPT_VARIATION_PROMPT_VERSION (see variationModelId.ts).
//
// The generator rewrites an existing image-generation prompt, changing ONLY the
// user-selected dimensions (pose / outfit / expression / place / mood_time) and
// preserving everything else — especially the identity of the person. It never
// invents person attributes and never escalates sexual/explicit content.
import type { VariationChange } from "./types";

/** Japanese guidance shown to the model for each change dimension. */
const CHANGE_GUIDE: Record<VariationChange, string> = {
  pose: "ポーズ（立つ・座る・歩く・振り向く・手の位置・体の向き など）",
  outfit: "服装（ワンピース・ドレス・私服・水着・スーツ・部屋着 など）",
  expression: "表情（笑顔・自然な表情・クール・リラックス・視線の方向 など）",
  place: "場所（海・プール・街中・ホテル・カフェ・室内・スタジオ など）",
  mood_time: "雰囲気・時間帯（朝・昼・夕方・夜・自然光・高級感・ナチュラル・クール など）",
};

export const PROMPT_VARIATION_SYSTEM_PROMPT = `あなたは画像生成プロンプトのバリエーションを作るアシスタントです。既存の画像生成プロンプトを受け取り、ユーザーが指定した要素だけを変えた新しい画像生成プロンプトを1つ作ります。

変更できる要素は次の5つだけです:
- ポーズ: 立つ・座る・歩く・振り向く・手の位置・体の向き
- 服装: ワンピース・ドレス・私服・水着・スーツ・部屋着 など
- 表情: 笑顔・自然な表情・クール・リラックス・視線の方向
- 場所: 海・プール・街中・ホテル・カフェ・室内・スタジオ など
- 雰囲気・時間帯: 朝・昼・夕方・夜・自然光・高級感・ナチュラル・クール など

ルール:
- ユーザーが指定した要素だけを変える。指定されていない要素は元のプロンプトの記述をできるだけそのまま保持する。
- 人物の同一性を不用意に変えない。顔立ち・髪型・体型・年齢感など、今回の変更項目に含まれない人物の特徴は変更しない。
- 元のプロンプトに書かれていない、年齢・国籍・人種・民族・体型評価・健康・宗教・性的指向などの人物属性を新たに追加・推測しない。
- 髪型・体型・年齢などは今回の変更項目ではないので変えない。
- 性的表現や露出の方向へ勝手に強めない。指示がない限り露出度を上げない。過度に性的・扇情的な表現を追加しない。
- 出力は新しい画像生成プロンプトの本文のみ。説明・前置き・注釈・箇条書き・複数案・解説は一切出さない。
- 元のプロンプトの言語を維持する。元が英語なら英語で、元が日本語なら日本語で出力する。英語のプロンプトを勝手に日本語化しない。`;

/**
 * Builds the per-request user message: the original prompt plus the list of
 * change dimensions to apply. The fixed system prompt above governs behavior;
 * this only supplies the concrete inputs (no user free-text is interpolated —
 * `changes` is a fixed enum, and the body is the stored prompt).
 */
export function buildVariationInput(originalPrompt: string, changes: VariationChange[]): string {
  const changeLines = changes.map((c) => `- ${CHANGE_GUIDE[c]}`).join("\n");
  return `次の画像生成プロンプトを元に、指定された要素だけを変えた新しいプロンプトを1つ作ってください。

変更する要素:
${changeLines}

元のプロンプト:
${originalPrompt}`;
}
