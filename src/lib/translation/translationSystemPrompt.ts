// Phase 10-9C-2: fixed system prompt for the real translation provider.
// Consumed by the OpenAI translation provider. If its meaning changes, bump
// TRANSLATION_PROMPT_VERSION (see translationModelId.ts).
//
// Translation only — prompt text in, Japanese text out. No image bytes, no
// analysis, no tags.
export const TRANSLATION_SYSTEM_PROMPT = `あなたはプロの翻訳者です。与えられた英語（または混在言語）のテキストを、自然で読みやすい日本語に翻訳してください。

ルール:
- 出力は翻訳後の日本語テキストのみ。説明・注釈・前置き・引用符・コードフェンスを付けない。
- 原文の意味・ニュアンスを保つ。過度な意訳や情報の追加・削除をしない。
- すでに日本語の部分はそのまま自然な日本語として残す。
- 入力に含まれない事実を創作しない。`;
