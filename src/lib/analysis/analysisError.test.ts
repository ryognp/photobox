import { describe, it, expect } from "vitest";
import { sanitizeAnalysisError } from "@/lib/analysis/analysisError";

describe("sanitizeAnalysisError", () => {
  it("redacts API-key-like substrings", () => {
    const msg = sanitizeAnalysisError(new Error("call failed: sk-abc123XYZ_-def"));
    expect(msg).not.toContain("sk-abc123XYZ_-def");
    expect(msg).toContain("[REDACTED_API_KEY]");
  });
  it("truncates to 500 chars", () => {
    expect(sanitizeAnalysisError(new Error("x".repeat(1000))).length).toBe(500);
  });
  it("handles non-Error input", () => {
    expect(sanitizeAnalysisError("plain")).toBe("plain");
    expect(sanitizeAnalysisError(123)).toBe("analysis failed");
    expect(sanitizeAnalysisError(null)).toBe("analysis failed");
  });
});
