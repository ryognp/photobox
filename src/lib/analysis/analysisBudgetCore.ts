// Pure analysis cost-guard logic (Phase 10-5D-2). No server-only, no Redis
// import — the Redis client is injected so this is unit-testable. The
// server wrapper (analysisBudget.ts) supplies the real client.
//
// fail-CLOSED: unlike the post-auth rate limiter (fail-OPEN for availability),
// the cost guard denies when Redis is missing or errors — a budget you can't
// verify must not be treated as available, or the daily cap is meaningless.
import { hashIdentity } from "@/lib/rateLimitCore";

export type AnalysisBudgetResult =
  | { allowed: true; remaining: number }
  | { allowed: false; reason: string };

/** Minimal Redis surface used by the cost guard (INCR + EXPIRE). */
export type BudgetRedisLike = {
  incr: (key: string) => Promise<number>;
  expire: (key: string, seconds: number) => Promise<unknown>;
};

const TWO_DAYS_SECONDS = 60 * 60 * 24 * 2;

/**
 * Atomically reserves one unit of the daily analysis budget for a
 * (workspace, provider, model) on a given UTC date. Uses Redis INCR so
 * concurrent requests cannot both slip past the limit. The count is NOT
 * refunded on later provider failure — a failed call may still have consumed
 * an upstream request / rate-limit / cost, and not refunding also deters abuse.
 *
 * workspaceId is hashed (never a raw Redis key), matching the rate limiter.
 */
export async function reserveBudgetWithRedis(args: {
  redis: BudgetRedisLike | null;
  workspaceId: string;
  providerId: string;
  modelId: string;
  limit: number;
  now?: Date;
}): Promise<AnalysisBudgetResult> {
  if (!args.redis) return { allowed: false, reason: "analysis budget unavailable" };

  const date = (args.now ?? new Date()).toISOString().slice(0, 10); // UTC YYYY-MM-DD
  const workspaceHash = hashIdentity(`workspace:${args.workspaceId}`);
  const key = `budget:analysis:${date}:${workspaceHash}:${args.providerId}:${args.modelId}`;

  try {
    const count = await args.redis.incr(key);
    // Set TTL only on first increment so the daily bucket self-expires.
    if (count === 1) await args.redis.expire(key, TWO_DAYS_SECONDS);
    if (count > args.limit) return { allowed: false, reason: "analysis daily budget exceeded" };
    return { allowed: true, remaining: Math.max(0, args.limit - count) };
  } catch {
    // fail-closed on Redis error.
    return { allowed: false, reason: "analysis budget unavailable" };
  }
}
