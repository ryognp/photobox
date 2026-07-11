import { describe, it, expect, vi } from "vitest";
import { reserveVariationBudgetWithRedis, type BudgetRedisLike } from "@/lib/promptVariation/variationBudgetCore";

function fakeRedis(overrides?: Partial<BudgetRedisLike>): BudgetRedisLike {
  return { incr: vi.fn(async () => 1), expire: vi.fn(async () => 1), ...overrides };
}

const BASE = {
  workspaceId: "ws1",
  providerId: "openai",
  modelId: "openai:gpt-4o-mini:prompt-var-v1",
  limit: 20,
  now: new Date("2026-07-11T12:00:00.000Z"),
};

describe("reserveVariationBudgetWithRedis", () => {
  it("fail-closed when redis is null", async () => {
    const r = await reserveVariationBudgetWithRedis({ redis: null, ...BASE });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("prompt variation budget unavailable");
  });

  it("fail-closed on redis error", async () => {
    const redis = fakeRedis({ incr: vi.fn(async () => { throw new Error("boom"); }) });
    const r = await reserveVariationBudgetWithRedis({ redis, ...BASE });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("prompt variation budget unavailable");
  });

  it("allows when under limit, sets TTL on first increment", async () => {
    const expire = vi.fn(async () => 1);
    const redis = fakeRedis({ incr: vi.fn(async () => 1), expire });
    const r = await reserveVariationBudgetWithRedis({ redis, ...BASE });
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.remaining).toBe(19);
    expect(expire).toHaveBeenCalledOnce();
  });

  it("does NOT set TTL when count > 1", async () => {
    const expire = vi.fn(async () => 1);
    const redis = fakeRedis({ incr: vi.fn(async () => 5), expire });
    await reserveVariationBudgetWithRedis({ redis, ...BASE });
    expect(expire).not.toHaveBeenCalled();
  });

  it("denies when over limit", async () => {
    const redis = fakeRedis({ incr: vi.fn(async () => 21) });
    const r = await reserveVariationBudgetWithRedis({ redis, ...BASE });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("prompt variation daily budget exceeded");
  });

  it("key contains prompt_variation, UTC date, modelId; workspaceId is hashed (not raw)", async () => {
    let seenKey = "";
    const redis = fakeRedis({ incr: vi.fn(async (k: string) => { seenKey = k; return 1; }) });
    await reserveVariationBudgetWithRedis({ redis, ...BASE });
    expect(seenKey).toContain("budget:prompt_variation:");
    expect(seenKey).toContain("2026-07-11");
    expect(seenKey).toContain("openai:gpt-4o-mini:prompt-var-v1");
    expect(seenKey).not.toContain("ws1"); // raw workspaceId never appears
  });
});
