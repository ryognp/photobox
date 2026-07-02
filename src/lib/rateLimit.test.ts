import { describe, it, expect, vi } from "vitest";
import {
  checkRateLimitWithLimiter,
  rateLimitHeaders,
  type LimiterLike,
} from "@/lib/rateLimitCore";

function makeLimiter(result: {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
}): LimiterLike {
  return { limit: vi.fn().mockResolvedValue(result) };
}

describe("checkRateLimitWithLimiter", () => {
  it("allows when limiter is null (Redis not configured)", async () => {
    const res = await checkRateLimitWithLimiter({
      preset: "uploadItem",
      userId: "u1",
      limiter: null,
    });
    expect(res.allowed).toBe(true);
    expect(res.enabled).toBe(false);
    expect(res.source).toBe("disabled");
  });

  it("denies when limit exceeded and computes retryAfterSec", async () => {
    const reset = Date.now() + 30_000;
    const res = await checkRateLimitWithLimiter({
      preset: "uploadCommit",
      userId: "u1",
      workspaceId: "w1",
      limiter: makeLimiter({ success: false, limit: 10, remaining: 0, reset }),
    });
    expect(res.allowed).toBe(false);
    expect(res.enabled).toBe(true);
    expect(res.source).toBe("shared");
    expect(res.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(res.retryAfterSec).toBeLessThanOrEqual(31);
  });

  it("allows with remaining when under the limit", async () => {
    const res = await checkRateLimitWithLimiter({
      preset: "uploadItem",
      userId: "u1",
      workspaceId: "w1",
      limiter: makeLimiter({
        success: true,
        limit: 60,
        remaining: 59,
        reset: Date.now() + 60_000,
      }),
    });
    expect(res.allowed).toBe(true);
    expect(res.remaining).toBe(59);
    expect(res.retryAfterSec).toBe(0);
  });

  it("fails open when limiter throws", async () => {
    const limiter: LimiterLike = {
      limit: vi.fn().mockRejectedValue(new Error("redis down")),
    };
    const res = await checkRateLimitWithLimiter({
      preset: "importParse",
      userId: "u1",
      limiter,
    });
    expect(res.allowed).toBe(true);
    expect(res.enabled).toBe(true);
    expect(res.source).toBe("error");
  });

  it("uses the same hashed key for the same identity", async () => {
    const calls: string[] = [];
    const limiter: LimiterLike = {
      limit: (key: string) => {
        calls.push(key);
        return Promise.resolve({
          success: true,
          limit: 60,
          remaining: 59,
          reset: Date.now() + 60_000,
        });
      },
    };
    await checkRateLimitWithLimiter({ preset: "uploadItem", userId: "u1", workspaceId: "w1", limiter });
    await checkRateLimitWithLimiter({ preset: "uploadItem", userId: "u1", workspaceId: "w1", limiter });
    expect(calls[0]).toBe(calls[1]);
    // Key must not contain the raw identifiers
    expect(calls[0]).not.toContain("u1");
    expect(calls[0]).not.toContain("w1");
  });
});

describe("rateLimitHeaders", () => {
  it("generates all four headers on denial, with Reset in epoch seconds", () => {
    const headers = new Headers(
      rateLimitHeaders({
        allowed: false,
        enabled: true,
        source: "shared",
        limit: 10,
        remaining: 0,
        reset: 1780000123456,
        retryAfterSec: 30,
        ms: 1,
      }),
    );
    expect(headers.get("X-RateLimit-Limit")).toBe("10");
    expect(headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(headers.get("X-RateLimit-Reset")).toBe("1780000124");
    expect(headers.get("Retry-After")).toBe("30");
  });

  it("omits Retry-After when allowed", () => {
    const headers = new Headers(
      rateLimitHeaders({
        allowed: true,
        enabled: true,
        source: "shared",
        limit: 60,
        remaining: 59,
        reset: 1780000123456,
        retryAfterSec: 0,
        ms: 1,
      }),
    );
    expect(headers.get("Retry-After")).toBeNull();
    expect(headers.get("X-RateLimit-Remaining")).toBe("59");
  });

  it("returns empty headers when limiter was disabled", () => {
    const headers = new Headers(
      rateLimitHeaders({ allowed: true, enabled: false, source: "disabled", ms: 0 }),
    );
    expect([...headers.keys()]).toHaveLength(0);
  });
});
