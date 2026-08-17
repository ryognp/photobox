import "server-only";

export const dynamic = "force-dynamic";
// Uses node:crypto (randomUUID) — Node.js runtime only.
export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { getCurrentUser, getDefaultWorkspaceForUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { ok, Errors } from "@/lib/apiResponse";
import {
  createPrismaSessionCleanupStore,
  runSessionCleanup,
  SESSION_CLEANUP_BATCH_SIZE,
} from "@/lib/cleanup/cleanupUploadsCore";
import type { StorageRemover } from "@/lib/upload/intentSweepCore";

const BUCKET = "photobox-private";
const DEFAULT_HOURS = 24;
const MIN_HOURS = 1;
const MAX_HOURS = 168;

// Cleanup 方針 (Phase 10-43-B3c-3):
// - cron と同じ session cleanup core（runSessionCleanup）を使用し、安全条件
//   （claim / fresh marker / COMMITTED 保護 / future notBefore / path 検証 /
//   storage-first / token 条件付き delete）を一切迂回しない
// - COMMITTED session / COMMITTED item は絶対に削除しない
// - Storage object の削除成功後にのみ session の DB 行を物理削除する
// - intent sweep は manual route では実行しない（既存 response 互換のため
//   cron 専用とする。COMMITTED session の staging 残骸も cron の intent sweep
//   が notBefore 以降に回収する — route.integration.test.ts で固定）
// - warnings は固定分類 + session id のみ（raw path / provider message /
//   token / lease timestamp を返さない）

const removeStorage: StorageRemover = async (paths) => {
  const { data, error } = await supabaseAdmin.storage.from(BUCKET).remove([...paths]);
  return { error, removedPaths: data ? data.map((object) => object.name) : null };
};

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();

  const workspace = await getDefaultWorkspaceForUser(user.id);
  if (!workspace) return Errors.forbidden();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const raw = body as Record<string, unknown>;
  const olderThanHoursRaw = raw.olderThanHours ?? DEFAULT_HOURS;
  const dryRun = raw.dryRun !== false; // default true

  if (typeof olderThanHoursRaw !== "number" || !Number.isFinite(olderThanHoursRaw)) {
    return Errors.validation("olderThanHours must be a number");
  }
  const olderThanHours = Math.floor(olderThanHoursRaw);
  if (olderThanHours < MIN_HOURS || olderThanHours > MAX_HOURS) {
    return Errors.validation(`olderThanHours must be between ${MIN_HOURS} and ${MAX_HOURS}`);
  }

  const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);

  const result = await runSessionCleanup({
    store: createPrismaSessionCleanupStore(prisma),
    removeStorage,
    now: () => new Date(),
    generateAttemptToken: () => randomUUID(),
    cutoff,
    dryRun,
    maxSessions: SESSION_CLEANUP_BATCH_SIZE,
    // workspace scoping: 現在ユーザーの workspace / user の session のみ対象。
    scope: { workspaceId: workspace.id, userId: user.id },
  });

  // 既存 response 契約（dryRun / olderThanHours / summary / sessions / warnings）
  // を維持し、B3c-3 metrics を additive に追加する。
  return ok({
    dryRun,
    olderThanHours,
    summary: {
      sessions: result.considered,
      items: result.itemsConsidered,
      storagePaths: result.plannedStoragePaths,
      deletedStoragePaths: result.storageDeleted,
      warnings: result.warnings.length,
    },
    sessions: result.sessions,
    warnings: result.warnings,
    // ---- additive metrics (B3c-3) ----
    deletedSessions: result.deleted,
    retainedSessions: result.retained,
    sessionsClaimed: result.claimed,
    sessionsSkippedFreshUploading: result.skippedFreshUploading,
    sessionsSkippedFreshCommit: result.skippedFreshCommit,
    sessionsSkippedFutureNotBefore: result.skippedFutureNotBefore,
    sessionsSkippedFinalizeInProgress: result.skippedFinalizeInProgress,
    sessionsSkippedIntentCleanupInProgress: result.skippedIntentCleanupInProgress,
    sessionsSkippedClaimConflict: result.skippedClaimConflict,
    sessionsSkippedCommittedItem: result.skippedCommittedItem,
    pathMismatch: result.pathFailures,
    storageMissing: result.storageMissing,
    storageFailed: result.storageFailed,
  });
}
