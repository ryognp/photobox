// Phase 10-11B: pure prompt-variation cost-guard logic. Mirrors
// src/lib/translation/translationBudgetCore.ts (intentionally duplicated rather
// than generalized — the analysis/translation versions stay untouched; common
// extraction is a future refactor). Redis client is injected so this is
// unit-testable.
//
// fail-CLOSED: unlike the post-auth rate limiter (fail-OPEN for availability),
// the cost guard denies when Redis is missing or errors — a budget you can't
// verify must not be treated as available, or the daily cap is meaningless.
import { hashIdentity } from "@/lib/rateLimitCore";

export type VariationBudgetResult =
  | { allowed: true; remaining: number }
  | { allowed: false; reason: string };

/** Minimal Redis surface used by the cost guard (INCR + EXPIRE). */
export type BudgetRedisLike = {
  incr: (key: string) => Promise<number>;
  expire: (key: string, seconds: number) => Promise<unknown>;
};

const TWO_DAYS_SECONDS = 60 * 60 * 24 * 2;

/**
 * Atomically reserves one unit of the daily prompt-variation budget for a
 * (workspace, provider, model) on a given UTC date. Uses Redis INCR so
 * concurrent requests cannot both slip past the limit. The count is NOT
 * refunded on later provider failure. workspaceId is hashed (never a raw key).
 */
export async function reserveVariationBudgetWithRedis(args: {
  redis: BudgetRedisLike | null;
  workspaceId: string;
  providerId: string;
  modelId: string;
  limit: number;
  now?: Date;
}): Promise<VariationBudgetResult> {
  if (!args.redis) return { allowed: false, reason: "prompt variation budget unavailable" };

  const date = (args.now ?? new Date()).toISOString().slice(0, 10); // UTC YYYY-MM-DD
  const workspaceHash = hashIdentity(`workspace:${args.workspaceId}`);
  const key = `budget:prompt_variation:${date}:${workspaceHash}:${args.providerId}:${args.modelId}`;

  try {
    const count = await args.redis.incr(key);
    if (count === 1) await args.redis.expire(key, TWO_DAYS_SECONDS);
    if (count > args.limit) return { allowed: false, reason: "prompt variation daily budget exceeded" };
    return { allowed: true, remaining: Math.max(0, args.limit - count) };
  } catch {
    return { allowed: false, reason: "prompt variation budget unavailable" };
  }
}
