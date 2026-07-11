import { describe, it, expect } from "vitest";
import { createMockVariationProvider } from "@/lib/promptVariation/mockProvider";

describe("createMockVariationProvider", () => {
  it("is deterministic and names the requested changes", async () => {
    const p = createMockVariationProvider("mock:mock:prompt-var-v1");
    expect(p.providerId).toBe("mock");
    expect(p.modelId).toBe("mock:mock:prompt-var-v1");

    const a = await p.generate("a woman on a beach", ["pose", "outfit"]);
    const b = await p.generate("a woman on a beach", ["pose", "outfit"]);
    expect(a).toEqual(b); // deterministic
    expect(a.text).toContain("a woman on a beach");
    expect(a.text).toContain("pose");
    expect(a.text).toContain("outfit");
  });

  it("labels mood_time readably", async () => {
    const p = createMockVariationProvider();
    const r = await p.generate("x", ["mood_time"]);
    expect(r.text).toContain("mood/time");
  });
});
