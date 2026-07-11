import { describe, it, expect } from "vitest";
import { VARIATION_CHANGES, isVariationChange } from "@/lib/promptVariation/types";

describe("VARIATION_CHANGES / isVariationChange", () => {
  it("has exactly the 5 confirmed dimensions in order", () => {
    expect([...VARIATION_CHANGES]).toEqual(["pose", "outfit", "expression", "place", "mood_time"]);
  });

  it("accepts known changes, rejects everything else", () => {
    for (const c of VARIATION_CHANGES) expect(isVariationChange(c)).toBe(true);
    expect(isVariationChange("hairstyle")).toBe(false);
    expect(isVariationChange("Pose")).toBe(false); // case-sensitive
    expect(isVariationChange(3)).toBe(false);
    expect(isVariationChange(null)).toBe(false);
    expect(isVariationChange(undefined)).toBe(false);
  });
});
