import { describe, it, expect } from "vitest";
import { parseNumberEnv } from "@/lib/parseNumberEnv";

describe("parseNumberEnv", () => {
  it("returns fallback for undefined / blank", () => {
    expect(parseNumberEnv(undefined, 100)).toBe(100);
    expect(parseNumberEnv("", 100)).toBe(100);
    expect(parseNumberEnv("   ", 100)).toBe(100);
  });
  it("returns fallback for NaN / non-numeric", () => {
    expect(parseNumberEnv("abc", 100)).toBe(100);
    expect(parseNumberEnv("12x", 100)).toBe(100);
  });
  it("returns fallback for 0 and negatives", () => {
    expect(parseNumberEnv("0", 100)).toBe(100);
    expect(parseNumberEnv("-5", 100)).toBe(100);
  });
  it("parses valid positive values, truncating floats", () => {
    expect(parseNumberEnv("20", 100)).toBe(20);
    expect(parseNumberEnv("20.9", 100)).toBe(20);
  });
});
