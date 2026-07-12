import { describe, it, expect } from "vitest";
import { PROMPT_VARIATION_SYSTEM_PROMPT, buildVariationInput } from "@/lib/promptVariation/variationPrompt";

describe("PROMPT_VARIATION_SYSTEM_PROMPT", () => {
  it("lists all 5 change dimensions", () => {
    for (const label of ["ポーズ", "服装", "表情", "場所", "雰囲気・時間帯"]) {
      expect(PROMPT_VARIATION_SYSTEM_PROMPT).toContain(label);
    }
  });

  it("states the safety constraints (identity, attribute inference, exposure)", () => {
    expect(PROMPT_VARIATION_SYSTEM_PROMPT).toContain("同一性");
    expect(PROMPT_VARIATION_SYSTEM_PROMPT).toMatch(/年齢・国籍・人種/);
    expect(PROMPT_VARIATION_SYSTEM_PROMPT).toContain("露出");
    // only the selected dimensions change; others are preserved
    expect(PROMPT_VARIATION_SYSTEM_PROMPT).toContain("指定されていない要素");
  });

  it("requires preserving the original prompt language (no auto-translation)", () => {
    expect(PROMPT_VARIATION_SYSTEM_PROMPT).toContain("言語を維持");
    expect(PROMPT_VARIATION_SYSTEM_PROMPT).toContain("英語なら英語");
    expect(PROMPT_VARIATION_SYSTEM_PROMPT).toContain("日本語なら日本語");
  });

  it("requires prompt-body-only output (no explanation / lists / multiple variants)", () => {
    expect(PROMPT_VARIATION_SYSTEM_PROMPT).toContain("本文のみ");
    expect(PROMPT_VARIATION_SYSTEM_PROMPT).toMatch(/複数案/);
  });
});

describe("buildVariationInput", () => {
  it("includes the original prompt and one line per requested change", () => {
    const input = buildVariationInput("a woman on a beach", ["pose", "place"]);
    expect(input).toContain("a woman on a beach");
    expect(input).toContain("ポーズ");
    expect(input).toContain("場所");
    // does not include unrequested dimensions
    expect(input).not.toContain("服装");
  });
});
