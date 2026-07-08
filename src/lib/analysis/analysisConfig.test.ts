import { describe, it, expect } from "vitest";
import {
  DEFAULT_ANALYSIS_MAX_INPUT_CHARS,
  DEFAULT_ANALYSIS_TIMEOUT_MS,
  DEFAULT_ANALYSIS_DAILY_CALL_LIMIT,
  readAnalysisMaxInputChars,
  readAnalysisTimeoutMs,
  readAnalysisDailyCallLimit,
  truncateAnalysisInput,
} from "@/lib/analysis/analysisConfig";

describe("analysis config readers", () => {
  it("fall back to defaults when unset / invalid", () => {
    expect(readAnalysisMaxInputChars({})).toBe(DEFAULT_ANALYSIS_MAX_INPUT_CHARS);
    expect(readAnalysisTimeoutMs({ AI_ANALYSIS_TIMEOUT_MS: "0" })).toBe(DEFAULT_ANALYSIS_TIMEOUT_MS);
    expect(readAnalysisDailyCallLimit({ AI_ANALYSIS_DAILY_CALL_LIMIT: "-1" })).toBe(DEFAULT_ANALYSIS_DAILY_CALL_LIMIT);
    expect(readAnalysisMaxInputChars({ AI_ANALYSIS_MAX_INPUT_CHARS: "NaN" })).toBe(DEFAULT_ANALYSIS_MAX_INPUT_CHARS);
  });
  it("read valid values", () => {
    expect(readAnalysisMaxInputChars({ AI_ANALYSIS_MAX_INPUT_CHARS: "6000" })).toBe(6000);
    expect(readAnalysisTimeoutMs({ AI_ANALYSIS_TIMEOUT_MS: "15000" })).toBe(15000);
    expect(readAnalysisDailyCallLimit({ AI_ANALYSIS_DAILY_CALL_LIMIT: "50" })).toBe(50);
  });
});

describe("truncateAnalysisInput", () => {
  it("returns text unchanged when within limit", () => {
    expect(truncateAnalysisInput("short", 8000)).toEqual({ text: "short", truncated: false });
  });
  it("truncates and appends a marker when over limit", () => {
    const result = truncateAnalysisInput("a".repeat(100), 10);
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith("a".repeat(10))).toBe(true);
    expect(result.text).toContain("切り詰め");
  });
  it("boundary: exactly at limit is not truncated", () => {
    expect(truncateAnalysisInput("abcde", 5)).toEqual({ text: "abcde", truncated: false });
  });
});
