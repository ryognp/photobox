import { describe, it, expect } from "vitest";
import { looksLikeTranslationRefusal, TRANSLATION_REFUSED_ERROR } from "@/lib/translation/refusalGuard";

describe("looksLikeTranslationRefusal", () => {
  it("true: JA refusals starting with an apology phrase", () => {
    expect(looksLikeTranslationRefusal("申し訳ございませんが、そのリクエストにはお応えできません。")).toBe(true);
    expect(looksLikeTranslationRefusal("申し訳ありませんが、対応できません。")).toBe(true);
  });

  it("true: JA output that IS a refusal phrase itself", () => {
    expect(looksLikeTranslationRefusal("お応えできません。")).toBe(true);
    expect(looksLikeTranslationRefusal("翻訳できません")).toBe(true);
  });

  it("true: EN refusals starting with a refusal phrase (incl. curly apostrophe)", () => {
    expect(looksLikeTranslationRefusal("I'm sorry, but I can't assist with that.")).toBe(true);
    // curly apostrophe variant that OpenAI often emits
    expect(looksLikeTranslationRefusal("I’m sorry, but I can’t help with this.")).toBe(true);
    expect(looksLikeTranslationRefusal("I cannot comply with this request.")).toBe(true);
    expect(looksLikeTranslationRefusal("Unable to help with this request.")).toBe(true);
  });

  it("false: generic 「対応できません/翻訳できません」 inside a real translation (NOT leading)", () => {
    expect(looksLikeTranslationRefusal("この形式には対応できません。")).toBe(false);
    expect(looksLikeTranslationRefusal("この古い機種には対応できません。")).toBe(false);
    expect(looksLikeTranslationRefusal("そのファイルは翻訳できませんという表示が出ている。")).toBe(false);
  });

  it("false: apology WORDS inside a normal (non-refusal) sentence", () => {
    expect(looksLikeTranslationRefusal("彼女は申し訳なさそうに微笑んだ。")).toBe(false);
    expect(looksLikeTranslationRefusal("申し訳ないという台詞を含む映画的なシーン")).toBe(false);
  });

  it("false: ordinary Japanese translation text", () => {
    expect(
      looksLikeTranslationRefusal("夕暮れのビーチに立つ女性、クロップトップとハイウエストのパンツ、自然光。"),
    ).toBe(false);
  });

  it("false: ordinary mixed EN/JA prompt", () => {
    expect(
      looksLikeTranslationRefusal("A woman on the beach at sunset, crop top, natural light, 全身ショット"),
    ).toBe(false);
  });

  it("false: empty / whitespace", () => {
    expect(looksLikeTranslationRefusal("")).toBe(false);
    expect(looksLikeTranslationRefusal("   \n  ")).toBe(false);
  });

  it("false: refusal-like phrase appearing mid-text (contains-anywhere is never used)", () => {
    // short text containing a phrase but not starting with it
    expect(looksLikeTranslationRefusal("その依頼にはお応えできませんと彼は言った。")).toBe(false);
    // long translation mentioning an apology far from the start
    const long =
      "モデルは白いドレスを着て立っている。" +
      "背景には海が広がり、遠くにヨットが見える。".repeat(6) +
      "彼は申し訳ありませんと小さくつぶやいた。";
    expect(looksLikeTranslationRefusal(long)).toBe(false);
  });

  it("exposes the stable error string", () => {
    expect(TRANSLATION_REFUSED_ERROR).toBe("translation provider refused");
  });
});
