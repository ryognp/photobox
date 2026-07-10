import { describe, it, expect } from "vitest";
import { looksLikeTranslationRefusal, TRANSLATION_REFUSED_ERROR } from "@/lib/translation/refusalGuard";

describe("looksLikeTranslationRefusal", () => {
  it("true: JA refusals starting with an apology phrase", () => {
    expect(looksLikeTranslationRefusal("申し訳ございませんが、そのリクエストにはお応えできません。")).toBe(true);
    expect(looksLikeTranslationRefusal("申し訳ありませんが、対応できません。")).toBe(true);
  });

  it("true: EN refusals (leading phrase / short + contains, curly apostrophe)", () => {
    expect(looksLikeTranslationRefusal("I'm sorry, but I can't assist with that.")).toBe(true);
    // curly apostrophe variant that OpenAI often emits
    expect(looksLikeTranslationRefusal("I’m sorry, but I can’t help with this.")).toBe(true);
    // doesn't start with the phrase, but short + contains "cannot comply"
    expect(looksLikeTranslationRefusal("I cannot comply with this request.")).toBe(true);
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

  it("false: long translation that merely mentions an apology far from the start", () => {
    const long =
      "モデルは白いドレスを着て立っている。" +
      "背景には海が広がり、遠くにヨットが見える。".repeat(6) +
      "彼は申し訳ありませんと小さくつぶやいた。";
    // > SHORT_TEXT_MAX and phrase is not at the start → not a refusal
    expect(long.length).toBeGreaterThan(120);
    expect(looksLikeTranslationRefusal(long)).toBe(false);
  });

  it("exposes the stable error string", () => {
    expect(TRANSLATION_REFUSED_ERROR).toBe("translation provider refused");
  });
});
