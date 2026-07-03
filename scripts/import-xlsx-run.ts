#!/usr/bin/env npx tsx
/**
 * XLSX Import Runner — Day 7-D (local CLI)
 *
 * Reads manifest.json produced by extract-xlsx-images, then for each record:
 *   1. Reads image buffer from images/ directory
 *   2. Computes SHA-256 (skip if already imported)
 *   3. Generates thumbnail (320px WebP, q78) and preview (1600px WebP, q85) via sharp
 *   4. Uploads original + thumbnail + preview to Supabase Storage (photobox-private)
 *   5. Creates Image + Prompt row in DB
 *   6. Creates an ImportBatch record
 *
 * Usage:
 *   npm run import:xlsx-run -- \
 *     --manifest /path/to/manifest.json \
 *     --workspace-id <workspaceId> \
 *     --user-id <userId> \
 *     [--scene-id <sceneId>] \
 *     [--dry-run] \
 *     [--concurrency 3]
 *
 * Security notes:
 *   - All Storage operations use the service role key (server-side only)
 *   - DB writes use DATABASE_URL directly via Prisma
 *   - workspaceId / userId come from CLI args (trusted local script)
 */

import { config as dotenvConfig } from "dotenv";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseArgs } from "node:util";

import sharp from "sharp";
import { createClient } from "@supabase/supabase-js";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import cuid from "cuid";

// ---- Config ---------------------------------------------------------------

const BUCKET = "photobox-private";

const THUMBNAIL_SIZE = 320;
const THUMBNAIL_QUALITY = 78;
const PREVIEW_SIZE = 1600;
const PREVIEW_QUALITY = 85;

// ---- Types ----------------------------------------------------------------

interface ManifestRecord {
  index: number;
  sheetName: string;
  rowNumber: number;
  row0: number;
  imageCol0: number;
  imageColumn: string;
  imageTarget: string;
  imageFileName: string;
  imageSizeBytes: number;
  outputFileName: string;
  outputRelativePath: string;
  hasImage: boolean;
  hasPromptEn: boolean;
  hasPromptJa: boolean;
  status: string;
  flags: string[];
  isDuplicateTarget: boolean;
  duplicateGroupKey: string | null;
  duplicateTargetCount: number;
  promptEn: string;
  promptJa: string;
}

interface Manifest {
  generatedAt: string;
  xlsxFile: string;
  sheetName: string;
  records: ManifestRecord[];
}

interface RunResult {
  record: ManifestRecord;
  outcome: "imported" | "skipped_duplicate" | "skipped_no_image" | "error";
  imageId?: string;
  errorMessage?: string;
  warnings: string[];
}

// ---- Args -----------------------------------------------------------------

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    manifest: { type: "string" },
    "workspace-id": { type: "string" },
    "user-id": { type: "string" },
    "scene-id": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    concurrency: { type: "string", default: "3" },
  },
  strict: false,
});

const manifestPath = args["manifest"] as string | undefined;
const workspaceIdRaw = args["workspace-id"] as string | undefined;
const userIdRaw = args["user-id"] as string | undefined;
const sceneId = (args["scene-id"] as string | undefined) ?? null;
const dryRun = (args["dry-run"] as boolean | undefined) ?? false;
const concurrency = Math.min(8, Math.max(1, parseInt(String(args["concurrency"] ?? "3"), 10)));

// ---- Validate args --------------------------------------------------------

if (!manifestPath || !workspaceIdRaw || !userIdRaw) {
  console.error(`
Usage:
  npm run import:xlsx-run -- \\
    --manifest /path/to/manifest.json \\
    --workspace-id <workspaceId> \\
    --user-id <userId> \\
    [--scene-id <sceneId>] \\
    [--dry-run] \\
    [--concurrency 3]
`);
  process.exit(1);
}

// After validation, these are guaranteed to be strings
const workspaceId: string = workspaceIdRaw;
const userId: string = userIdRaw;

// Load .env / .env.local (try both; .env.local overrides .env)
dotenvConfig({ path: path.resolve(process.cwd(), ".env") });
dotenvConfig({ path: path.resolve(process.cwd(), ".env.local"), override: true });

if (!fs.existsSync(manifestPath)) {
  console.error(`manifest not found: ${manifestPath}`);
  process.exit(1);
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env / .env.local");
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("Missing DATABASE_URL in .env / .env.local");
  process.exit(1);
}

// ---- Clients (initialized after env load + validation) -------------------

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

// ---- Helpers --------------------------------------------------------------

function sha256(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function extFromFileName(fileName: string): string {
  return (path.extname(fileName).replace(".", "") || "bin").toLowerCase();
}

function mimeFromExt(ext: string): string {
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    heic: "image/heic",
  };
  return map[ext] ?? "application/octet-stream";
}

// Upload a single buffer to Supabase Storage, replacing if it exists
async function uploadBuffer(
  storagePath: string,
  buffer: Buffer,
  contentType: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { error } = await supabase.storage.from(BUCKET).upload(storagePath, buffer, {
    contentType,
    upsert: true,
  });
  if (!error) return { ok: true };
  return { ok: false, message: error.message };
}

// Generate thumbnail or preview WebP buffer; returns null on failure
async function generateVariant(
  sourceBuffer: Buffer,
  longEdge: number,
  quality: number,
): Promise<Buffer | null> {
  try {
    return await sharp(sourceBuffer)
      .resize({ width: longEdge, height: longEdge, fit: "inside", withoutEnlargement: true })
      .webp({ quality })
      .toBuffer();
  } catch {
    return null;
  }
}

// Concurrency limiter
function makeConcurrencyLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= limit) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = queue.shift();
      if (next) next();
    }
  };
}

// ---- Process one record ---------------------------------------------------

async function processRecord(
  record: ManifestRecord,
  imagesDir: string,
): Promise<RunResult> {
  const warnings: string[] = [];

  if (!record.hasImage || !record.outputFileName) {
    return { record, outcome: "skipped_no_image", warnings };
  }

  const imagePath = path.join(imagesDir, record.outputFileName);
  if (!fs.existsSync(imagePath)) {
    return {
      record,
      outcome: "error",
      errorMessage: `Image file not found: ${imagePath}`,
      warnings,
    };
  }

  // Read original buffer
  const originalBuffer = fs.readFileSync(imagePath);
  const fileHash = sha256(originalBuffer);

  // Check duplicate by fileHash — non-deleted images only (統一方針)。
  // soft-deleted image は重複扱いしない。ただしDB unique制約は削除済みも数えるため、
  // 実際のcreateで P2002 が出る可能性があり、下の transaction で捕捉する。
  if (!dryRun) {
    const existing = await prisma.image.findFirst({
      where: { workspaceId, fileHash, deletedAt: null, status: { not: "DELETED" } },
      select: { id: true },
    });
    if (existing) {
      return { record, outcome: "skipped_duplicate", imageId: existing.id, warnings };
    }
  }

  // sharp metadata for dimensions
  let widthPx: number | null = null;
  let heightPx: number | null = null;
  try {
    const meta = await sharp(originalBuffer).metadata();
    widthPx = meta.width ?? null;
    heightPx = meta.height ?? null;
  } catch {
    warnings.push("sharp metadata failed — widthPx/heightPx will be null");
  }

  // Generate variants
  const thumbnailBuffer = await generateVariant(originalBuffer, THUMBNAIL_SIZE, THUMBNAIL_QUALITY);
  const previewBuffer = await generateVariant(originalBuffer, PREVIEW_SIZE, PREVIEW_QUALITY);

  if (!thumbnailBuffer) warnings.push("thumbnail generation failed — thumbnailPath will be null");
  if (!previewBuffer) warnings.push("preview generation failed — previewPath will be null");

  const imageId = cuid();
  const ext = extFromFileName(record.imageFileName);
  const mimeType = mimeFromExt(ext);

  const originalPath = `${workspaceId}/assets/${imageId}/original.${ext}`;
  const thumbnailPath = thumbnailBuffer ? `${workspaceId}/assets/${imageId}/thumbnail.webp` : null;
  const previewPath = previewBuffer ? `${workspaceId}/assets/${imageId}/preview.webp` : null;

  if (dryRun) {
    return {
      record,
      outcome: "imported",
      imageId,
      warnings,
    };
  }

  // Upload original
  const uploadOriginal = await uploadBuffer(originalPath, originalBuffer, mimeType);
  if (!uploadOriginal.ok) {
    return {
      record,
      outcome: "error",
      errorMessage: `Original upload failed: ${uploadOriginal.message}`,
      warnings,
    };
  }

  // Upload thumbnail (non-fatal)
  if (thumbnailBuffer && thumbnailPath) {
    const r = await uploadBuffer(thumbnailPath, thumbnailBuffer, "image/webp");
    if (!r.ok) {
      warnings.push(`thumbnail upload failed: ${r.message}`);
    }
  }

  // Upload preview (non-fatal)
  if (previewBuffer && previewPath) {
    const r = await uploadBuffer(previewPath, previewBuffer, "image/webp");
    if (!r.ok) {
      warnings.push(`preview upload failed: ${r.message}`);
    }
  }

  // Determine prompt body (EN full-text preferred; JA as fallback)
  const promptBody = record.promptEn || record.promptJa || "";

  // DB: create Image + Prompt in a transaction
  try {
    await prisma.$transaction(async (tx) => {
      await tx.image.create({
        data: {
          id: imageId,
          workspaceId,
          sceneId,
          storageBucket: BUCKET,
          storagePath: originalPath,
          thumbnailPath: thumbnailBuffer ? thumbnailPath : null,
          previewPath: previewBuffer ? previewPath : null,
          originalName: record.imageFileName,
          originalExt: ext,
          mimeType,
          fileSizeBytes: originalBuffer.length,
          widthPx,
          heightPx,
          fileHash,
          sourceSheetName: record.sheetName,
          sourceRow: record.rowNumber,
          sourceColumn: record.imageCol0,
          searchText: [record.promptEn, record.promptJa].filter(Boolean).join(" ").slice(0, 2000),
        },
      });

      if (promptBody) {
        await tx.prompt.create({
          data: {
            workspaceId,
            imageId,
            originalBody: promptBody,
            currentBody: promptBody,
          },
        });
      }
    });
  } catch (e: unknown) {
    // P2002 = unique (workspaceId, fileHash) violation. The dup check above
    // excludes soft-deleted images, but the DB constraint still counts them.
    // Recover gracefully (no hard fail): treat as skipped duplicate.
    const isP2002 =
      typeof e === "object" && e !== null && "code" in e &&
      (e as { code?: unknown }).code === "P2002";
    if (isP2002) {
      const conflicting = await prisma.image.findFirst({
        where: { workspaceId, fileHash },
        select: { id: true, status: true },
      });
      // The original/thumbnail/preview were uploaded before the DB transaction.
      // Since we're skipping this row, remove those now-orphaned storage objects
      // (best-effort; failure is a warning, never fatal).
      const cleanupPaths = [originalPath, thumbnailPath, previewPath].filter(Boolean) as string[];
      if (cleanupPaths.length > 0) {
        const { error: cleanupError } = await supabase.storage.from(BUCKET).remove(cleanupPaths);
        if (cleanupError) warnings.push(`P2002 storage cleanup failed: ${cleanupError.message}`);
      }
      warnings.push(
        `P2002 on (workspaceId, fileHash); likely conflicts with a soft-deleted image (existingId=${conflicting?.id ?? "?"}, status=${conflicting?.status ?? "?"}). Skipped. Full re-import support is pending (Phase 6C).`,
      );
      return { record, outcome: "skipped_duplicate", imageId: conflicting?.id, warnings };
    }
    throw e;
  }

  return { record, outcome: "imported", imageId, warnings };
}

// ---- Main -----------------------------------------------------------------

async function main() {
  const manifest: Manifest = JSON.parse(fs.readFileSync(manifestPath!, "utf-8"));
  const manifestDir = path.dirname(manifestPath!);
  const imagesDir = path.join(manifestDir, "images");

  if (!fs.existsSync(imagesDir)) {
    console.error(`images/ directory not found: ${imagesDir}`);
    process.exit(1);
  }

  const records = manifest.records.filter((r) => r.status === "ready" || r.status === "missing_prompt" /* allow missing JA */);

  console.log(`\n📋 XLSX Import Runner — Day 7-D`);
  console.log(`   manifest:     ${manifestPath}`);
  console.log(`   xlsx file:    ${manifest.xlsxFile}`);
  console.log(`   sheet:        ${manifest.sheetName}`);
  console.log(`   records:      ${manifest.records.length} total, ${records.length} eligible`);
  console.log(`   workspaceId:  ${workspaceId}`);
  console.log(`   userId:       ${userId}`);
  console.log(`   sceneId:      ${sceneId ?? "(none)"}`);
  console.log(`   concurrency:  ${concurrency}`);
  console.log(`   dry-run:      ${dryRun}`);
  console.log(`   thumbnail:    ${THUMBNAIL_SIZE}px WebP q${THUMBNAIL_QUALITY}`);
  console.log(`   preview:      ${PREVIEW_SIZE}px WebP q${PREVIEW_QUALITY}`);

  // Create ImportBatch
  let batchId: string | null = null;
  if (!dryRun) {
    const batch = await prisma.importBatch.create({
      data: {
        workspaceId,
        userId,
        fileName: manifest.xlsxFile,
        fileType: "xlsx",
        rowCount: records.length,
        status: "PROCESSING",
      },
    });
    batchId = batch.id;
    console.log(`\n📦 ImportBatch created: ${batchId}`);

    // Back-fill importBatchId after images are created (done at the end)
  }

  // Process with concurrency limit
  const limiter = makeConcurrencyLimiter(concurrency);
  const results: RunResult[] = [];
  let done = 0;

  console.log(`\n🚀 Processing ${records.length} records (concurrency=${concurrency})...\n`);

  await Promise.all(
    records.map((record) =>
      limiter(async () => {
        const result = await processRecord(record, imagesDir);
        results.push(result);
        done++;

        const icon =
          result.outcome === "imported" ? "✅" :
          result.outcome === "skipped_duplicate" ? "🔁" :
          result.outcome === "skipped_no_image" ? "⏭️" : "❌";
        const warnStr = result.warnings.length > 0 ? ` [${result.warnings.length} warnings]` : "";
        console.log(
          `  ${icon} [${done}/${records.length}] row=${record.rowNumber} ${record.imageFileName}` +
          (result.errorMessage ? ` — ${result.errorMessage}` : "") +
          warnStr
        );
      })
    )
  );

  // ---- Tally results -------------------------------------------------------
  const imported = results.filter((r) => r.outcome === "imported");
  const skippedDup = results.filter((r) => r.outcome === "skipped_duplicate");
  const skippedNoImg = results.filter((r) => r.outcome === "skipped_no_image");
  const errors = results.filter((r) => r.outcome === "error");
  const withWarnings = results.filter((r) => r.warnings.length > 0);
  const allErrors: Array<{ row: number; reason: string }> = errors.map((r) => ({
    row: r.record.rowNumber,
    reason: r.errorMessage ?? "unknown error",
  }));

  // Update ImportBatch with importBatchId on images + finalize batch
  if (!dryRun && batchId) {
    const importedIds = imported.map((r) => r.imageId!).filter(Boolean);
    if (importedIds.length > 0) {
      await prisma.image.updateMany({
        where: { id: { in: importedIds } },
        data: { importBatchId: batchId },
      });
    }
    await prisma.importBatch.update({
      where: { id: batchId },
      data: {
        importedCount: imported.length,
        skippedCount: skippedDup.length + skippedNoImg.length,
        errorCount: errors.length,
        status: errors.length === records.length ? "FAILED" : "DONE",
        errorLog: allErrors.length > 0 ? JSON.stringify(allErrors) : null,
        updatedAt: new Date(),
      },
    });
  }

  // ---- Summary -------------------------------------------------------------
  console.log(`\n📊 Summary:`);
  console.log(`   ✅ imported:          ${imported.length}`);
  console.log(`   🔁 skipped (dup):     ${skippedDup.length}`);
  console.log(`   ⏭️  skipped (no img):  ${skippedNoImg.length}`);
  console.log(`   ❌ errors:            ${errors.length}`);
  console.log(`   ⚠️  with warnings:    ${withWarnings.length}`);

  if (withWarnings.length > 0) {
    console.log(`\n⚠️  Warning details:`);
    for (const r of withWarnings) {
      console.log(`   row=${r.record.rowNumber}: ${r.warnings.join("; ")}`);
    }
  }
  if (errors.length > 0) {
    console.log(`\n❌ Error details:`);
    for (const r of errors) {
      console.log(`   row=${r.record.rowNumber}: ${r.errorMessage}`);
    }
  }

  if (!dryRun && batchId) {
    console.log(`\n📦 ImportBatch: ${batchId} → status=${errors.length === records.length ? "FAILED" : "DONE"}`);
  }
  if (dryRun) {
    console.log(`\n🧪 DRY RUN — no DB writes or Storage uploads were performed.`);
  }

  console.log(`\n✅ Done.`);
}

main()
  .catch((e) => {
    console.error("Fatal error:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
