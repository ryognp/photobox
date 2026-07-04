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
import { purgeDeletedImagesCore, NO_STORAGE_PATHS_ERROR, type PurgeImage } from "@/lib/purge/purgeDeletedImagesCore";

const BUCKET = "photobox-private";
const DEFAULT_RETENTION_DAYS = 30;
const MIN_RETENTION_DAYS = 7;
const MAX_RETENTION_DAYS = 365;
// Bounded per run. Physical storage deletion is irreversible; keep batches small.
const MAX_IMAGES = 200;
const CONFIRM_TOKEN = "purge-deleted-images";
// Vercel Cron identification (JST 03:00 = UTC 18:00). Must match vercel.json.
const PURGE_CRON_SCHEDULE = "0 18 * * *";
const VERCEL_CRON_UA = "vercel-cron/1.0";

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
 * - Default is DRY-RUN. Actual deletion fires only via (a) manual
 *   `dryRun=0&confirm=purge-deleted-images`, or (b) a Vercel Cron request
 *   (identified by vercel-cron UA + x-vercel-cron-schedule; real auth is the
 *   CRON_SECRET Bearer).
 * - Only status=DELETED images with deletedAt older than retention are eligible,
 *   and only those not already PURGED (storagePurgeStatus IN NONE/FAILED).
 * - Storage is removed before the DB is marked; storage failure → FAILED, never
 *   PURGED (see purgeDeletedImagesCore).
 *
 * Phase 7B: wired into vercel.json crons at `0 18 * * *` (JST 03:00).
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

  // ── Trigger detection: manual vs Vercel Cron ─────────────────────────────
  // Actual purge fires in exactly two ways:
  //   1) Manual:  ?dryRun=0&confirm=purge-deleted-images
  //   2) Cron:    Vercel-Cron request (query-less path). Identified by the
  //               vercel-cron User-Agent AND the exact schedule header. The
  //               REAL auth is the CRON_SECRET Bearer verified above; the UA /
  //               schedule headers only distinguish cron-origin from manual
  //               (they are spoofable and are NOT the security boundary).
  // Anything else defaults to DRY-RUN.
  const sp = request.nextUrl.searchParams;

  const ua = request.headers.get("user-agent") ?? "";
  const isCron =
    ua.includes(VERCEL_CRON_UA) &&
    request.headers.get("x-vercel-cron-schedule") === PURGE_CRON_SCHEDULE;

  let dryRun: boolean;
  if (isCron) {
    dryRun = false; // cron → actual (Bearer already verified above)
  } else {
    // Manual: default dry-run; actual requires dryRun=0 AND confirm token.
    const wantsActual = sp.get("dryRun") === "0";
    if (wantsActual && sp.get("confirm") !== CONFIRM_TOKEN) {
      return noStore(
        Errors.validation(`Actual purge requires confirm=${CONFIRM_TOKEN} (with dryRun=0)`),
      );
    }
    dryRun = !wantsActual;
  }

  const retentionRaw = parseInt(sp.get("retentionDays") ?? String(DEFAULT_RETENTION_DAYS), 10);
  const retentionDays = Number.isNaN(retentionRaw) ? DEFAULT_RETENTION_DAYS : retentionRaw;
  if (retentionDays < MIN_RETENTION_DAYS || retentionDays > MAX_RETENTION_DAYS) {
    return noStore(
      Errors.validation(`retentionDays must be between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS}`),
    );
  }

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  // ── Fetch eligible images (DELETED, past retention, not yet PURGED) ───────
  // Exclude rows that failed with NO_STORAGE_PATHS: retrying them never
  // succeeds (there is nothing to remove), so they would burn a scan slot
  // every run. They stay FAILED and are surfaced only via audit.
  const images = await prisma.image.findMany({
    where: {
      status: "DELETED",
      deletedAt: { lt: cutoff },
      storagePurgeStatus: { in: ["NONE", "FAILED"] },
      NOT: { storagePurgeError: NO_STORAGE_PATHS_ERROR },
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
    perf.end({ dryRun: true, trigger: isCron ? "cron" : "manual", retentionDays, scanned: purgeImages.length, plannedStoragePaths });
    return noStore(
      ok({ dryRun: true, retentionDays, scanned: purgeImages.length, plannedStoragePaths }),
    );
  }

  // ── Execute: storage-safe per-image purge ────────────────────────────────
  const result = await purgeDeletedImagesCore(purgeImages, {
    removeStorage: async (paths) => {
      // Supabase Storage remove() is idempotent: already-absent paths are NOT
      // errors (they are simply omitted from the result). So a re-run after a
      // markPurged DB failure finds the files gone, returns error=null, and
      // converges to PURGED — never a permanent FAILED.
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
    trigger: isCron ? "cron" : "manual",
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
