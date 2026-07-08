import { describe, it, expect } from "vitest";
import { ANALYSIS_SYSTEM_PROMPT } from "@/lib/analysis/analysisPrompt";

describe("ANALYSIS_SYSTEM_PROMPT", () => {
  it("states the core constraints (Japanese-only, count, attribute prohibition)", () => {
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("日本語");
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("5〜10");
    // person-attribute prohibition must be present as the first line of defense
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/年齢|性別|人種/);
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("JSON Schema");
  });
});
