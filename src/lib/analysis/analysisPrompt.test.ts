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
});
