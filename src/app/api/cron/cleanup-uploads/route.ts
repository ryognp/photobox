import "server-only";

export const dynamic = "force-dynamic";
// Uses node:crypto (timingSafeEqual / randomUUID) — Node.js runtime only.
export const runtime = "nodejs";
// Phase 10-43-B3c-3: 承認済み cron runtime 契約。IN_FLIGHT_GRACE_MS(60min) ≫
// maxDuration を repo 内で証明可能にする。
export const maxDuration = 60;

import { NextRequest } from "next/server";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { ok, err, Errors } from "@/lib/apiResponse";
import { createPerfLog } from "@/lib/perfLog";
import {
  createPrismaSessionCleanupStore,
  runSessionCleanup,
  SESSION_CLEANUP_BATCH_SIZE,
} from "@/lib/cleanup/cleanupUploadsCore";
import {
  createPrismaIntentSweepStore,
  runIntentSweep,
  INTENT_SWEEP_BATCH_SIZE,
  type StorageRemover,
} from "@/lib/upload/intentSweepCore";

const BUCKET = "photobox-private";
const DEFAULT_HOURS = 24;
const MIN_HOURS = 1;
const MAX_HOURS = 168;

// Storage remove adapter。error は raw のまま core へ渡し、core 側の
// normalizeStorageError() だけが解釈する（route で message match しない）。
const removeStorage: StorageRemover = async (paths) => {
  const { data, error } = await supabaseAdmin.storage.from(BUCKET).remove([...paths]);
  return { error, removedPaths: data ? data.map((object) => object.name) : null };
};

/**
 * Global cleanup of abandoned upload sessions + upload-intent storage sweep
 * across ALL workspaces (Phase 10-43-B3c-3).
 *
 * Auth: Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}` when the
 * CRON_SECRET env var is set. This endpoint is fail-CLOSED — if CRON_SECRET
 * is missing or the header does not match, it rejects (unlike user-facing
 * routes which fail-open on rate limit).
 *
 * Invoked by GET (Vercel Cron). `?dryRun=1` returns the plan without deleting.
 *
 * 正式順序: cron auth → intent sweep → session cleanup → fixed metrics。
 * 1 invocation の上限: intent 100 / session 25。個別 candidate の失敗は
 * core 内で分離され、run 全体は throw しない。
 */
export async function GET(request: NextRequest) {
  const perf = createPerfLog("cron.cleanupUploads");
  const startedAtMs = performance.now();

  // ── Auth: constant-time Bearer compare against CRON_SECRET ──────────────
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // No secret configured → refuse rather than run unauthenticated.
    return Errors.unauthorized();
  }
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return Errors.unauthorized();
  }
  perf.mark("authMs");

  // ── Params ──────────────────────────────────────────────────────────────
  const sp = request.nextUrl.searchParams;
  const dryRun = sp.get("dryRun") === "1";
  const olderThanHoursRaw = parseInt(sp.get("olderThanHours") ?? String(DEFAULT_HOURS), 10);
  const olderThanHours = Number.isNaN(olderThanHoursRaw) ? DEFAULT_HOURS : olderThanHoursRaw;
  if (olderThanHours < MIN_HOURS || olderThanHours > MAX_HOURS) {
    return Errors.validation(`olderThanHours must be between ${MIN_HOURS} and ${MAX_HOURS}`);
  }

  const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);
  const intentStore = createPrismaIntentSweepStore(prisma);
  const sessionStore = createPrismaSessionCleanupStore(prisma);

  // ── 1. Intent sweep（cross-workspace・batch 100） ────────────────────────
  // dryRun は完全 read-only: claim 0 / Storage remove 0 / DB update 0。
  let intentSweep: {
    candidates: number;
    skipped: number;
    claimed: number;
    cleaned: number;
    expired: number;
    retryableFailed: number;
    terminalFailed: number;
    storageDeleted: number;
    storageMissing: number;
    storageFailed: number;
    deadLetterTotal: number;
    deadLetterByCode: Record<string, number>;
    warnings: string[];
  };
  if (dryRun) {
    const [candidates, deadLetters] = await Promise.all([
      intentStore.listCandidates({ now: new Date(), take: INTENT_SWEEP_BATCH_SIZE }),
      intentStore.countDeadLetters(),
    ]);
    intentSweep = {
      candidates: candidates.length,
      skipped: 0,
      claimed: 0,
      cleaned: 0,
      expired: 0,
      retryableFailed: 0,
      terminalFailed: 0,
      storageDeleted: 0,
      storageMissing: 0,
      storageFailed: 0,
      deadLetterTotal: deadLetters.total,
      deadLetterByCode: deadLetters.byCode,
      warnings: [],
    };
  } else {
    intentSweep = await runIntentSweep({
      store: intentStore,
      removeStorage,
      now: () => new Date(),
      generateAttemptToken: () => randomUUID(),
    });
  }
  perf.mark("intentSweepMs");

  // ── 2. Session storage-first cleanup（batch 25） ─────────────────────────
  const sessionResult = await runSessionCleanup({
    store: sessionStore,
    removeStorage,
    now: () => new Date(),
    generateAttemptToken: () => randomUUID(),
    cutoff,
    dryRun,
    maxSessions: SESSION_CLEANUP_BATCH_SIZE,
  });
  perf.mark("cleanupMs");

  const durationMs = Math.round(performance.now() - startedAtMs);
  const warnings = [...intentSweep.warnings, ...sessionResult.warnings];

  perf.end({
    dryRun,
    olderThanHours,
    intentCandidates: intentSweep.candidates,
    intentClaimed: intentSweep.claimed,
    intentCleaned: intentSweep.cleaned,
    intentExpired: intentSweep.expired,
    intentRetryableFailed: intentSweep.retryableFailed,
    intentDeadLetter: intentSweep.deadLetterTotal,
    sessionsConsidered: sessionResult.considered,
    sessionsClaimed: sessionResult.claimed,
    sessionsDeleted: sessionResult.deleted,
    sessionsRetained: sessionResult.retained,
    storageDeleted: intentSweep.storageDeleted + sessionResult.storageDeleted,
    storageMissing: intentSweep.storageMissing + sessionResult.storageMissing,
    storageFailed: intentSweep.storageFailed + sessionResult.storageFailed,
    pathMismatch: sessionResult.pathFailures,
    warningCount: warnings.length,
    durationMs,
  });

  if (warnings.length > 0) {
    // warnings は固定分類 + id のみ（raw path / provider message / token を含まない）。
    console.warn("[cron.cleanupUploads] warnings", { warnings });
  }
  if (intentSweep.deadLetterTotal > 0) {
    console.warn("[cron.cleanupUploads] dead-letter intents require manual reset", {
      deadLetterTotal: intentSweep.deadLetterTotal,
      deadLetterByCode: intentSweep.deadLetterByCode,
    });
  }

  // 既存 response field は維持し、B3c-3 の metrics は additive に追加する。
  const base = {
    dryRun,
    olderThanHours,
    scannedSessions: sessionResult.considered,
    skippedCommittedMixedSessions: sessionResult.skippedCommittedItem,
    // ---- additive metrics (B3c-3) ----
    sessionsConsidered: sessionResult.considered,
    sessionsClaimed: sessionResult.claimed,
    sessionsDeleted: sessionResult.deleted,
    sessionsSkippedFreshUploading: sessionResult.skippedFreshUploading,
    sessionsSkippedFreshCommit: sessionResult.skippedFreshCommit,
    sessionsSkippedFutureNotBefore: sessionResult.skippedFutureNotBefore,
    sessionsSkippedFinalizeInProgress: sessionResult.skippedFinalizeInProgress,
    sessionsSkippedIntentCleanupInProgress: sessionResult.skippedIntentCleanupInProgress,
    sessionsSkippedClaimConflict: sessionResult.skippedClaimConflict,
    sessionsSkippedCommittedSession: sessionResult.skippedCommittedSession,
    storageDeleted: intentSweep.storageDeleted + sessionResult.storageDeleted,
    storageMissing: intentSweep.storageMissing + sessionResult.storageMissing,
    storageFailed: intentSweep.storageFailed + sessionResult.storageFailed,
    pathMismatch: sessionResult.pathFailures,
    intentSweep: {
      candidates: intentSweep.candidates,
      skipped: intentSweep.skipped,
      claimed: intentSweep.claimed,
      cleaned: intentSweep.cleaned,
      expired: intentSweep.expired,
      retryableFailed: intentSweep.retryableFailed,
      terminalFailed: intentSweep.terminalFailed,
      storageDeleted: intentSweep.storageDeleted,
      storageMissing: intentSweep.storageMissing,
      storageFailed: intentSweep.storageFailed,
      deadLetterTotal: intentSweep.deadLetterTotal,
      deadLetterByCode: intentSweep.deadLetterByCode,
    },
    durationMs,
  };

  if (dryRun) {
    return ok({
      ...base,
      plannedStoragePaths: sessionResult.plannedStoragePaths,
    });
  }

  return ok({
    ...base,
    deletedSessions: sessionResult.deleted,
    retainedSessions: sessionResult.retained,
    deletedStoragePaths: sessionResult.storageDeleted,
    warnings,
  });
}

// Reject non-GET verbs explicitly (Vercel Cron uses GET).
export function POST() {
  return err("VALIDATION_ERROR", "Use GET (cron endpoint)", 405);
}
