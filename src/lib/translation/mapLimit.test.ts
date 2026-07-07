import { describe, it, expect } from "vitest";
import { mapLimit } from "@/lib/translation/mapLimit";

describe("mapLimit", () => {
  it("resolves all items in order, preserving index correspondence", async () => {
    const results = await mapLimit([1, 2, 3, 4], 2, async (n) => n * 10);
    expect(results).toEqual([
      { status: "fulfilled", value: 10 },
      { status: "fulfilled", value: 20 },
      { status: "fulfilled", value: 30 },
      { status: "fulfilled", value: 40 },
    ]);
  });

  it("never runs more than `concurrency` items at once", async () => {
    let active = 0;
    let maxActive = 0;
    await mapLimit(
      Array.from({ length: 10 }, (_, i) => i),
      3,
      async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      },
    );
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("a rejected item does not abort the others", async () => {
    const results = await mapLimit([1, 2, 3], 3, async (n) => {
      if (n === 2) throw new Error("boom");
      return n;
    });
    expect(results[0]).toEqual({ status: "fulfilled", value: 1 });
    expect(results[1].status).toBe("rejected");
    expect(results[2]).toEqual({ status: "fulfilled", value: 3 });
  });

  it("handles empty input", async () => {
    const results = await mapLimit([], 3, async (n: number) => n);
    expect(results).toEqual([]);
  });
});
