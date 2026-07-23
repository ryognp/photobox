import { describe, it, expect } from "vitest";
import { MAX_ORIGINAL_BYTES, MAX_TOTAL_BYTES, MAX_ORIGINAL_MB } from "@/lib/upload/uploadLimits";

describe("uploadLimits", () => {
  it("caps the original file at 5MB", () => {
    expect(MAX_ORIGINAL_BYTES).toBe(5 * 1024 * 1024);
    expect(MAX_ORIGINAL_MB).toBe(5);
  });

  it("keeps the total payload cap above the original cap with headroom for thumbnail/preview", () => {
    expect(MAX_TOTAL_BYTES).toBeGreaterThan(MAX_ORIGINAL_BYTES);
    expect(MAX_TOTAL_BYTES - MAX_ORIGINAL_BYTES).toBe(2 * 1024 * 1024);
  });
});
