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
      "evening", "sunset", "dusk", "twilight",
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

  it("Phase 10-10A: time-of-day is still framed as top priority", () => {
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("時間帯（最優先）");
  });

  it("Phase 10-10B: prioritizes NOT mistagging over aggressively tagging time-of-day", () => {
    // Phase 10-10A's "積極的に出す" (aggressively output) caused morning
    // photos to be mistagged 夕方 — replaced with a stricter "only when
    // strongly implied, otherwise omit" instruction.
    expect(ANALYSIS_SYSTEM_PROMPT).not.toMatch(/積極的に出す/);
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("不確かな場合は時間帯タグを出さない");
  });

  it("Phase 10-10B: 'golden hour -> 夕方' is no longer a direct mapping", () => {
    const timeOfDayMappingLine = ANALYSIS_SYSTEM_PROMPT.split("\n").find((l) => l.includes("→ 夕方"));
    expect(timeOfDayMappingLine).toBeDefined();
    expect(timeOfDayMappingLine).not.toContain("golden hour");
  });

  it("Phase 10-10B: golden hour is ambiguous — direction word required to resolve it", () => {
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("golden hour");
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("単独では時間帯タグを出さない");
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("morning golden hour");
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("sunrise golden hour");
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("evening golden hour");
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("sunset golden hour");
  });

  it("Phase 10-10B: bare light-quality words do not imply a time-of-day", () => {
    for (const term of ["warm light", "golden light", "soft light", "natural light"]) {
      expect(ANALYSIS_SYSTEM_PROMPT).toContain(term);
    }
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("時間帯を推定しない");
  });
});
