import { describe, it, expect } from "vitest";
import { ANALYSIS_SYSTEM_PROMPT } from "@/lib/analysis/analysisPrompt";

describe("ANALYSIS_SYSTEM_PROMPT", () => {
  it("states the core constraints (Japanese-only, count cap, big-category focus, attribute prohibition)", () => {
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("日本語");
    // Phase 10-5E: max 8 big-category tags (was "5〜10")
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("最大8件");
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/時間帯|衣装|大カテゴリ/);
    // person-attribute prohibition must be present as the first line of defense
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/年齢|性別|人種/);
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("JSON Schema");
  });

  it("Phase 10-10A: does not list 人物 or ポートレート as candidate tags", () => {
    // "人物" / "ポートレート" still legitimately appear elsewhere (the safety
    // section's "人物の年齢・性別・人種..." prohibition, and the explicit
    // "do not output these" instruction below) — so assert on the
    // candidate-tag ENUMERATION lines specifically, not a blanket not.toContain
    // over the whole prompt.
    const compositionLine = ANALYSIS_SYSTEM_PROMPT.split("\n").find((l) => l.includes("構図"));
    const subjectLine = ANALYSIS_SYSTEM_PROMPT.split("\n").find((l) => l.includes("被写体"));
    expect(compositionLine).toBeDefined();
    expect(subjectLine).toBeDefined();
    expect(compositionLine).not.toContain("ポートレート");
    expect(subjectLine).not.toContain("人物");
    // explicit instruction not to output these two
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("「人物」「ポートレート」は出さない");
  });

  it("Phase 10-10A: includes English time-of-day terms mapped to their JA tag", () => {
    for (const term of [
      "morning", "sunrise", "daytime", "noon", "afternoon",
      "evening", "sunset", "dusk", "twilight", "golden hour",
      "night", "nighttime",
    ]) {
      expect(ANALYSIS_SYSTEM_PROMPT).toContain(term);
    }
    // still maps to the JA labels (not just listing English words)
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("→ 朝");
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("→ 昼");
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("→ 夕方");
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("→ 夜");
  });

  it("Phase 10-10A: instructs aggressive time-of-day tagging as top priority", () => {
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("時間帯（最優先）");
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/積極的に出す/);
  });
});
