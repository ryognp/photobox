import "server-only";

import { getRedisClient } from "@/lib/cache/redisClient";
import {
  reserveVariationBudgetWithRedis,
  type VariationBudgetResult,
  type BudgetRedisLike,
} from "./variationBudgetCore";

export type { VariationBudgetResult } from "./variationBudgetCore";

/**
 * Server wrapper for the prompt-variation cost guard (Phase 10-11B). Injects
 * the shared Upstash Redis client into the pure core. fail-closed: if Redis is
 * not configured, the core denies.
 */
export async function reserveVariationBudget(args: {
  workspaceId: string;
  providerId: string;
  modelId: string;
  limit: number;
  now?: Date;
}): Promise<VariationBudgetResult> {
  const redis = getRedisClient() as BudgetRedisLike | null;
  return reserveVariationBudgetWithRedis({ redis, ...args });
}
