import { describe, it, expect, vi } from "vitest";
import { reserveTranslationBudgetWithRedis, type BudgetRedisLike } from "@/lib/translation/translationBudgetCore";

function fakeRedis(overrides?: Partial<BudgetRedisLike>): BudgetRedisLike {
  return { incr: vi.fn(async () => 1), expire: vi.fn(async () => 1), ...overrides };
}

const BASE = {
  workspaceId: "ws1",
  providerId: "openai",
  modelId: "openai:gpt-4o-mini:tr-v1",
  limit: 20,
  now: new Date("2026-07-10T12:00:00.000Z"),
};

describe("reserveTranslationBudgetWithRedis", () => {
  it("fail-closed when redis is null", async () => {
    const r = await reserveTranslationBudgetWithRedis({ redis: null, ...BASE });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("translation budget unavailable");
  });

  it("fail-closed when redis throws", async () => {
    const redis = fakeRedis({ incr: vi.fn(async () => { throw new Error("down"); }) });
    const r = await reserveTranslationBudgetWithRedis({ redis, ...BASE });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("translation budget unavailable");
  });

  it("allows within limit and returns remaining", async () => {
    const redis = fakeRedis({ incr: vi.fn(async () => 3) });
    const r = await reserveTranslationBudgetWithRedis({ redis, ...BASE, limit: 10 });
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.remaining).toBe(7);
  });

  it("sets TTL only on the first increment", async () => {
    const expire1 = vi.fn(async () => 1);
    await reserveTranslationBudgetWithRedis({ redis: fakeRedis({ incr: vi.fn(async () => 1), expire: expire1 }), ...BASE });
    expect(expire1).toHaveBeenCalledTimes(1);
    const expire2 = vi.fn(async () => 1);
    await reserveTranslationBudgetWithRedis({ redis: fakeRedis({ incr: vi.fn(async () => 5), expire: expire2 }), ...BASE });
    expect(expire2).not.toHaveBeenCalled();
  });

  it("denies when count exceeds limit", async () => {
    const redis = fakeRedis({ incr: vi.fn(async () => 21) });
    const r = await reserveTranslationBudgetWithRedis({ redis, ...BASE, limit: 20 });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("translation daily budget exceeded");
  });

  it("keys by UTC date, translation prefix, and hashed workspaceId", async () => {
    let seenKey = "";
    const redis = fakeRedis({ incr: vi.fn(async (k: string) => { seenKey = k; return 1; }) });
    await reserveTranslationBudgetWithRedis({ redis, ...BASE });
    expect(seenKey).toContain("budget:translation:");
    expect(seenKey).toContain("2026-07-10");
    expect(seenKey).toContain("openai:gpt-4o-mini:tr-v1");
    expect(seenKey).not.toContain("ws1"); // workspaceId hashed
  });
});
