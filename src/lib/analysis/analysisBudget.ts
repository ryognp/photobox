import "server-only";

import { getRedisClient } from "@/lib/cache/redisClient";
import {
  reserveBudgetWithRedis,
  type AnalysisBudgetResult,
  type BudgetRedisLike,
} from "./analysisBudgetCore";

export type { AnalysisBudgetResult } from "./analysisBudgetCore";

/**
 * Server wrapper for the analysis cost guard (Phase 10-5D-2). Injects the
 * shared Upstash Redis client into the pure core. fail-closed: if Redis is not
 * configured, the core denies (budget cannot be verified → do not spend).
 */
export async function reserveAnalysisBudget(args: {
  workspaceId: string;
  providerId: string;
  modelId: string;
  limit: number;
  now?: Date;
}): Promise<AnalysisBudgetResult> {
  // Upstash's client exposes incr/expire; narrow to the minimal surface.
  const redis = getRedisClient() as BudgetRedisLike | null;
  return reserveBudgetWithRedis({ redis, ...args });
}
