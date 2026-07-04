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
import { purgeDeletedImagesCore, type PurgeImage } from "@/lib/purge/purgeDeletedImagesCore";

const BUCKET = "photobox-private";
const DEFAULT_RETENTION_DAYS = 30;
const MIN_RETENTION_DAYS = 7;
const MAX_RETENTION_DAYS = 365;
// Bounded per run. Physical storage deletion is irreversible; keep batches small.
const MAX_IMAGES = 200;
const CONFIRM_TOKEN = "purge-deleted-images";

function noStore<T extends { headers: Headers }>(res: T): T {
  res.headers.set("Cache-Control", "no-store");
  return res;
}

/**
 * Physically purge Supabase Storage objects of soft-deleted images past the
 * retention window. The DB row is KEPT for audit; storage_purge_status is set
 * to PURGED (success) or FAILED (retry next run).
 *
 * Auth: fail-CLOSED Bearer CRON_SECRET (constant-time). Missing/mismatched → 401.
 *
 * SAFETY: physical deletion is irreversible.
 * - Default is DRY-RUN. Actual deletion requires BOTH `dryRun=0` AND
 *   `confirm=purge-deleted-images`.
 * - Only status=DELETED images with deletedAt older than retention are eligible,
 *   and only those not already PURGED (storagePurgeStatus IN NONE/FAILED).
 * - Storage is removed before the DB is marked; storage failure → FAILED, never
 *   PURGED (see purgeDeletedImagesCore).
 *
 * NOTE (Phase 7A): NOT yet wired into vercel.json crons. Manual invocation only
 * until Phase 7B (after prod migration + dry-run verification).
 */
export async function GET(request: NextRequest) {
  const perf = createPerfLog("cron.purgeDeletedImages");

  // ── Auth: constant-time Bearer compare against CRON_SECRET ──────────────
  const secret = process.env.CRON_SECRET;
  if (!secret) return noStore(Errors.unauthorized());
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return noStore(Errors.unauthorized());
  }
  perf.mark("authMs");

  // ── Params ──────────────────────────────────────────────────────────────
  const sp = request.nextUrl.searchParams;
  // Default is dry-run. Actual purge requires explicit dryRun=0.
  const dryRun = sp.get("dryRun") !== "0";
  const confirm = sp.get("confirm");

  const retentionRaw = parseInt(sp.get("retentionDays") ?? String(DEFAULT_RETENTION_DAYS), 10);
  const retentionDays = Number.isNaN(retentionRaw) ? DEFAULT_RETENTION_DAYS : retentionRaw;
  if (retentionDays < MIN_RETENTION_DAYS || retentionDays > MAX_RETENTION_DAYS) {
    return noStore(
      Errors.validation(`retentionDays must be between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS}`),
    );
  }

  // Actual-delete guard: require an explicit confirm token.
  if (!dryRun && confirm !== CONFIRM_TOKEN) {
    return noStore(
      Errors.validation(`Actual purge requires confirm=${CONFIRM_TOKEN} (with dryRun=0)`),
    );
  }

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  // ── Fetch eligible images (DELETED, past retention, not yet PURGED) ───────
  const images = await prisma.image.findMany({
    where: {
      status: "DELETED",
      deletedAt: { lt: cutoff },
      storagePurgeStatus: { in: ["NONE", "FAILED"] },
    },
    take: MAX_IMAGES,
    orderBy: { deletedAt: "asc" },
    select: {
      id: true,
      storagePath: true,
      thumbnailPath: true,
      previewPath: true,
    },
  });
  perf.mark("queryMs");

  const purgeImages: PurgeImage[] = images.map((img) => ({
    id: img.id,
    paths: [img.storagePath, img.thumbnailPath, img.previewPath],
  }));
  const plannedStoragePaths = purgeImages.reduce(
    (n, i) => n + new Set(i.paths.filter(Boolean)).size,
    0,
  );

  if (dryRun) {
    perf.end({ dryRun: true, retentionDays, scanned: purgeImages.length, plannedStoragePaths });
    return noStore(
      ok({ dryRun: true, retentionDays, scanned: purgeImages.length, plannedStoragePaths }),
    );
  }

  // ── Execute: storage-safe per-image purge ────────────────────────────────
  const result = await purgeDeletedImagesCore(purgeImages, {
    removeStorage: async (paths) => {
      const { error } = await supabaseAdmin.storage.from(BUCKET).remove(paths);
      return { error: error ? error.message : null };
    },
    markPurged: async (id) => {
      await prisma.image.updateMany({
        where: { id, storagePurgeStatus: { not: "PURGED" } },
        data: { storagePurgeStatus: "PURGED", storagePurgedAt: new Date(), storagePurgeError: null },
      });
    },
    markFailed: async (id, error) => {
      await prisma.image.updateMany({
        where: { id, storagePurgeStatus: { not: "PURGED" } },
        data: { storagePurgeStatus: "FAILED", storagePurgeError: error },
      });
    },
  });
  perf.mark("purgeMs");

  perf.end({
    dryRun: false,
    retentionDays,
    scanned: result.scanned,
    purged: result.purged,
    failed: result.failed,
    purgedStoragePaths: result.purgedStoragePaths,
    warningCount: result.warnings.length,
  });

  if (result.warnings.length > 0) {
    console.warn("[cron.purgeDeletedImages] warnings", { warnings: result.warnings });
  }

  return noStore(
    ok({
      dryRun: false,
      retentionDays,
      scanned: result.scanned,
      purged: result.purged,
      failed: result.failed,
      purgedStoragePaths: result.purgedStoragePaths,
      warnings: result.warnings,
    }),
  );
}

// Reject non-GET verbs explicitly (Vercel Cron uses GET).
export function POST() {
  return noStore(err("VALIDATION_ERROR", "Use GET (cron endpoint)", 405));
}
