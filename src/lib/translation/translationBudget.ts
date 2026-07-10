import "server-only";

import { getRedisClient } from "@/lib/cache/redisClient";
import {
  reserveTranslationBudgetWithRedis,
  type TranslationBudgetResult,
  type BudgetRedisLike,
} from "./translationBudgetCore";

export type { TranslationBudgetResult } from "./translationBudgetCore";

/**
 * Server wrapper for the translation cost guard (Phase 10-9C-2). Injects the
 * shared Upstash Redis client into the pure core. fail-closed: if Redis is not
 * configured, the core denies. Defined now; invoked by the single-image
 * translate route in Phase 10-9C-3.
 */
export async function reserveTranslationBudget(args: {
  workspaceId: string;
  providerId: string;
  modelId: string;
  limit: number;
  now?: Date;
}): Promise<TranslationBudgetResult> {
  const redis = getRedisClient() as BudgetRedisLike | null;
  return reserveTranslationBudgetWithRedis({ redis, ...args });
}
