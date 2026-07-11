import { describe, it, expect, vi } from "vitest";
import { reserveBudgetWithRedis, type BudgetRedisLike } from "@/lib/analysis/analysisBudgetCore";

function fakeRedis(overrides?: Partial<BudgetRedisLike>): BudgetRedisLike {
  return {
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    ...overrides,
  };
}

const BASE = {
  workspaceId: "ws1",
  providerId: "openai",
  modelId: "openai:gpt-4o-mini:ja-tags-v5",
  limit: 100,
  now: new Date("2026-07-08T12:00:00.000Z"),
};

describe("reserveBudgetWithRedis", () => {
  it("fail-closed when redis is null (unlike the fail-open rate limiter)", async () => {
    const r = await reserveBudgetWithRedis({ redis: null, ...BASE });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("analysis budget unavailable");
  });

  it("fail-closed when redis throws", async () => {
    const redis = fakeRedis({ incr: vi.fn(async () => { throw new Error("redis down"); }) });
    const r = await reserveBudgetWithRedis({ redis, ...BASE });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("analysis budget unavailable");
  });

  it("allows within limit and returns remaining", async () => {
    const redis = fakeRedis({ incr: vi.fn(async () => 3) });
    const r = await reserveBudgetWithRedis({ redis, ...BASE, limit: 10 });
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.remaining).toBe(7);
  });

  it("sets TTL only on the first increment", async () => {
    const expire = vi.fn(async () => 1);
    const redisFirst = fakeRedis({ incr: vi.fn(async () => 1), expire });
    await reserveBudgetWithRedis({ redis: redisFirst, ...BASE });
    expect(expire).toHaveBeenCalledTimes(1);

    const expire2 = vi.fn(async () => 1);
    const redisLater = fakeRedis({ incr: vi.fn(async () => 5), expire: expire2 });
    await reserveBudgetWithRedis({ redis: redisLater, ...BASE });
    expect(expire2).not.toHaveBeenCalled();
  });

  it("denies when count exceeds limit", async () => {
    const redis = fakeRedis({ incr: vi.fn(async () => 11) });
    const r = await reserveBudgetWithRedis({ redis, ...BASE, limit: 10 });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("analysis daily budget exceeded");
  });

  it("keys by UTC date and does NOT include the raw workspaceId (it is hashed)", async () => {
    let seenKey = "";
    const redis = fakeRedis({ incr: vi.fn(async (k: string) => { seenKey = k; return 1; }) });
    await reserveBudgetWithRedis({ redis, ...BASE });
    expect(seenKey).toContain("2026-07-08");
    expect(seenKey).toContain("openai");
    expect(seenKey).toContain("openai:gpt-4o-mini:ja-tags-v5");
    expect(seenKey).not.toContain("ws1"); // workspaceId is hashed
  });
});
