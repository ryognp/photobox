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

  // Phase 10-10C: v4's "only when strongly implied / omit if uncertain"
  // instruction sat at the top of the time-of-day section (applying to the
  // WHOLE category) and appears to have suppressed recall even for clear
  // signals (morning/sunrise stopped producing a tag too). v5 restores
  // "always output when a clear time word is present" as the default and
  // narrows the omit-if-uncertain caveat to the ambiguous terms only.
  it("Phase 10-10C: instructs ALWAYS outputting a tag when a clear time word is present", () => {
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("対応する時間帯タグを必ず1件出す");
  });

  it("Phase 10-10C: does NOT gate the whole time-of-day category behind 'only if strongly implied'", () => {
    // The old blanket phrasing that suppressed recall for the whole category.
    expect(ANALYSIS_SYSTEM_PROMPT).not.toContain("時間や光の描写が明示またはかなり強く示唆される場合だけ");
    // "不確かなら出さない" style wording must not appear as a standalone
    // sentence governing the whole time-of-day category — it may only appear
    // scoped inside the golden-hour ambiguity caveat line.
    const timeSectionLines = ANALYSIS_SYSTEM_PROMPT.split("\n").slice(
      ANALYSIS_SYSTEM_PROMPT.split("\n").findIndex((l) => l.includes("時間帯（最優先）")),
      ANALYSIS_SYSTEM_PROMPT.split("\n").findIndex((l) => l.includes("2. 衣装")),
    );
    const uncertainLines = timeSectionLines.filter((l) => l.includes("不確か"));
    expect(uncertainLines.length).toBeGreaterThan(0);
    for (const l of uncertainLines) {
      expect(l).toContain("golden hour");
    }
  });

  it("Phase 10-10C: clear time words still win over bare light-quality words when both are present", () => {
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("明確な時間語を優先して対応する時間帯タグを出す");
  });
});
