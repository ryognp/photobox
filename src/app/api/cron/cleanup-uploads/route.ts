import "server-only";

export const dynamic = "force-dynamic";
// Uses node:crypto (timingSafeEqual) — Node.js runtime only.
export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { ok, err, Errors } from "@/lib/apiResponse";
import { createPerfLog } from "@/lib/perfLog";
import { cleanupUploadsCore, type CleanupSession } from "@/lib/cleanup/cleanupUploadsCore";

const BUCKET = "photobox-private";
const DEFAULT_HOURS = 24;
const MIN_HOURS = 1;
const MAX_HOURS = 168;
// Bounded per run; the cron fires every few hours so the backlog drains steadily.
const MAX_SESSIONS = 200;

/**
 * Global cleanup of abandoned upload sessions across ALL workspaces.
 *
 * Auth: Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}` when the
 * CRON_SECRET env var is set. This endpoint is fail-CLOSED — if CRON_SECRET
 * is missing or the header does not match, it rejects (unlike user-facing
 * routes which fail-open on rate limit).
 *
 * Invoked by GET (Vercel Cron). `?dryRun=1` returns the plan without deleting.
 */
export async function GET(request: NextRequest) {
  const perf = createPerfLog("cron.cleanupUploads");

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

  // ── Fetch abandoned sessions across all workspaces (never COMMITTED) ──────
  const sessions = await prisma.uploadSession.findMany({
    where: {
      status: { in: ["ACTIVE", "PREVIEWING", "ABANDONED"] },
      createdAt: { lt: cutoff },
    },
    take: MAX_SESSIONS,
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      status: true,
      items: {
        select: {
          commitStatus: true,
          tempStoragePath: true,
          tempThumbnailPath: true,
          tempPreviewPath: true,
        },
      },
    },
  });
  perf.mark("queryMs");

  // Build cleanup input: collect temp paths of non-committed items only.
  const cleanupSessions: CleanupSession[] = sessions.map((s) => {
    const tempPaths: string[] = [];
    for (const item of s.items) {
      if (item.commitStatus === "COMMITTED") continue;
      if (item.tempStoragePath) tempPaths.push(item.tempStoragePath);
      if (item.tempThumbnailPath) tempPaths.push(item.tempThumbnailPath);
      if (item.tempPreviewPath) tempPaths.push(item.tempPreviewPath);
    }
    return { id: s.id, status: s.status, tempPaths };
  });

  const totalStoragePaths = cleanupSessions.reduce((n, s) => n + s.tempPaths.length, 0);

  if (dryRun) {
    perf.end({ dryRun: true, olderThanHours, scannedSessions: cleanupSessions.length, totalStoragePaths });
    return ok({
      dryRun: true,
      olderThanHours,
      scannedSessions: cleanupSessions.length,
      plannedStoragePaths: totalStoragePaths,
    });
  }

  // ── Execute: storage-safe per-session deletion ───────────────────────────
  const result = await cleanupUploadsCore(cleanupSessions, {
    removeStorage: async (paths) => {
      const { error } = await supabaseAdmin.storage.from(BUCKET).remove(paths);
      return { error: error ? error.message : null };
    },
    deleteSession: async (id) => {
      // Safety valve: never delete a session that flipped to COMMITTED.
      const res = await prisma.uploadSession.deleteMany({
        where: { id, status: { not: "COMMITTED" } },
      });
      if (res.count === 0) {
        throw new Error("session not deleted (status changed to COMMITTED or already gone)");
      }
    },
  });
  perf.mark("cleanupMs");

  perf.end({
    dryRun: false,
    olderThanHours,
    scannedSessions: result.scannedSessions,
    deletedSessions: result.deletedSessions,
    retainedSessions: result.retainedSessions,
    deletedStoragePaths: result.deletedStoragePaths,
    warningCount: result.warnings.length,
  });

  if (result.warnings.length > 0) {
    console.warn("[cron.cleanupUploads] warnings", { warnings: result.warnings });
  }

  return ok({
    dryRun: false,
    olderThanHours,
    scannedSessions: result.scannedSessions,
    deletedSessions: result.deletedSessions,
    retainedSessions: result.retainedSessions,
    deletedStoragePaths: result.deletedStoragePaths,
    warnings: result.warnings,
  });
}

// Reject non-GET verbs explicitly (Vercel Cron uses GET).
export function POST() {
  return err("VALIDATION_ERROR", "Use GET (cron endpoint)", 405);
}
