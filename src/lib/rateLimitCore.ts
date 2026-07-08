// Pure rate-limit logic — no server-only, no Redis dependency.
// Uses node:crypto (Node.js runtime only). If ever needed from Edge runtime,
// replace hashIdentity with a WebCrypto implementation.
import { createHash } from "node:crypto";

export type RateLimitPreset =
  | "uploadItem"
  | "uploadCommit"
  | "importParse"
  | "galleryRead"
  | "aiAnalyze"
  | "tagSuggestionAction"
  | "translationBatch";

export type RateLimitSource = "shared" | "disabled" | "error";

export type RateLimitResult = {
  allowed: boolean;
  enabled: boolean;
  source: RateLimitSource;
  limit?: number;
  remaining?: number;
  reset?: number;
  retryAfterSec?: number;
  ms: number;
};

export type LimiterLike = {
  limit: (key: string) => Promise<{
    success: boolean;
    limit: number;
    remaining: number;
    reset: number;
  }>;
};

/** SHA-256 hash so userId/workspaceId never appear as raw Redis keys.
 * Exported so other Redis-keyed features (e.g. analysis cost guard) can hash
 * identifiers the same way. */
export function hashIdentity(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}

function getIdentityKey(args: {
  userId: string;
  workspaceId?: string | null;
}): string {
  const raw = args.workspaceId
    ? `workspace:${args.workspaceId}:user:${args.userId}`
    : `user:${args.userId}`;

  return hashIdentity(raw);
}

export async function checkRateLimitWithLimiter(args: {
  preset: RateLimitPreset;
  userId: string;
  workspaceId?: string | null;
  limiter: LimiterLike | null;
}): Promise<RateLimitResult> {
  const startedAt = Date.now();

  if (!args.limiter) {
    return {
      allowed: true,
      enabled: false,
      source: "disabled",
      ms: Date.now() - startedAt,
    };
  }

  const key = getIdentityKey({
    userId: args.userId,
    workspaceId: args.workspaceId,
  });

  try {
    const result = await args.limiter.limit(key);
    const now = Date.now();
    const retryAfterSec = result.success
      ? 0
      : Math.max(1, Math.ceil((result.reset - now) / 1000));

    return {
      allowed: result.success,
      enabled: true,
      source: "shared",
      limit: result.limit,
      remaining: result.remaining,
      reset: result.reset,
      retryAfterSec,
      ms: Date.now() - startedAt,
    };
  } catch (error) {
    // Fail-open: Upstash outage must not take down the API.
    console.warn("[rateLimit] check failed; fail-open", {
      preset: args.preset,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      allowed: true,
      enabled: true,
      source: "error",
      ms: Date.now() - startedAt,
    };
  }
}

export function rateLimitHeaders(result: RateLimitResult): HeadersInit {
  const headers: Record<string, string> = {};

  if (result.limit !== undefined) {
    headers["X-RateLimit-Limit"] = String(result.limit);
  }

  if (result.remaining !== undefined) {
    headers["X-RateLimit-Remaining"] = String(result.remaining);
  }

  if (result.reset !== undefined) {
    // Epoch seconds (Upstash reset is epoch milliseconds)
    headers["X-RateLimit-Reset"] = String(Math.ceil(result.reset / 1000));
  }

  if (!result.allowed && result.retryAfterSec !== undefined) {
    headers["Retry-After"] = String(result.retryAfterSec);
  }

  return headers;
}
