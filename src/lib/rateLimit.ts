import "server-only";

import { Ratelimit } from "@upstash/ratelimit";
import { getRedisClient } from "@/lib/cache/redisClient";
import {
  checkRateLimitWithLimiter,
  type LimiterLike,
  type RateLimitPreset,
  type RateLimitResult,
} from "@/lib/rateLimitCore";

export { rateLimitHeaders } from "@/lib/rateLimitCore";
export type { RateLimitPreset, RateLimitResult } from "@/lib/rateLimitCore";

/**
 * Post-auth rate limiting for heavy endpoints (upload / import).
 * NOT a defense against unauthenticated DoS — that requires a pre-auth
 * IP-based layer (future task).
 *
 * Fail-open: if Redis is not configured or errors, requests pass through
 * (visible via rateLimitEnabled / rateLimitSource in perf logs).
 */
const PRESETS: Record<RateLimitPreset, { limit: number; window: `${number} ${"s" | "m" | "h"}` }> = {
  uploadItem: { limit: 60, window: "1 m" },
  uploadCommit: { limit: 10, window: "1 m" },
  importParse: { limit: 10, window: "1 m" },
  galleryRead: { limit: 300, window: "1 m" }, // defined but not applied yet
  aiAnalyze: { limit: 20, window: "1 m" }, // POST /api/images/[id]/analyze
  tagSuggestionAction: { limit: 60, window: "1 m" }, // approve/reject suggestion
  translationBatch: { limit: 10, window: "1 m" }, // POST /api/prompts/translate-batch
  translatePrompt: { limit: 10, window: "1 m" }, // POST /api/images/[id]/translate-prompt (定義のみ・適用は10-9C-3)
  promptVariation: { limit: 10, window: "1 m" }, // POST /api/images/[id]/prompt-variations (Phase 10-11B)
  personAssignAction: { limit: 30, window: "1 m" }, // POST/DELETE /api/images/[id]/persons[/[personId]] (Phase 10-15B)
};

const limiters = new Map<RateLimitPreset, LimiterLike>();
let warnedMissingRedis = false;

function getLimiter(preset: RateLimitPreset): LimiterLike | null {
  const redis = getRedisClient();

  if (!redis) {
    if (process.env.NODE_ENV === "production" && !warnedMissingRedis) {
      warnedMissingRedis = true;
      console.warn("[rateLimit] Redis is not configured; rate limiting is disabled.");
    }
    return null;
  }

  const existing = limiters.get(preset);
  if (existing) return existing;

  const config = PRESETS[preset];

  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(config.limit, config.window),
    prefix: `ratelimit:${preset}`,
    analytics: false,
  });

  limiters.set(preset, limiter);
  return limiter;
}

export async function checkUserRateLimit(args: {
  preset: RateLimitPreset;
  userId: string;
  workspaceId?: string | null;
}): Promise<RateLimitResult> {
  return checkRateLimitWithLimiter({
    ...args,
    limiter: getLimiter(args.preset),
  });
}
