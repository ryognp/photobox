import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { SupabaseClient } from "@supabase/supabase-js";
import { PrismaClient, Prisma } from "../../src/generated/prisma/client";
import { generateVariants } from "./imgVariants";
import { uploadBuffer } from "./storage";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImportManifestOptions {
  manifestPath: string;
  imagesDir: string;
  workspaceId: string;
  userId: string;
  sceneId: string | null;
  personId: string | null;
  tagIds: string[];
  dryRun: boolean;
  limit: number | null;
  concurrency: number;
  batchLabel?: string;
}

export interface ImportManifestResult {
  batchId: string | null;
  imported: number;
  skippedDuplicate: number;
  skippedNoImage: number;
  errors: number;
  warningCount: number;
  promptVersionsCreated: number;
  totalUploadedBytes: number;
  errorDetails: Array<{ row: number; reason: string }>;
  importedImages: Array<{ row: number; imageId: string; outputFileName: string }>;
}

// ---------------------------------------------------------------------------
// Manifest record types
// ---------------------------------------------------------------------------

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
  promptEnPreview: string;
  promptJaPreview: string;
}

interface Manifest {
  generatedAt: string;
  xlsxFile: string;
  sheetName: string;
  mediaFileCount: number;
  anchorCount: number;
  recordCount: number;
  readyCount: number;
  records: ManifestRecord[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STORAGE_BUCKET = "photobox-private";

function extToMime(ext: string): string {
  switch (ext.toLowerCase()) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function isP2002(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

/** Run tasks with bounded concurrency. */
async function withConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
}

/**
 * Attempt to handle a duplicate image: check prompt_versions and create if needed.
 * Returns the number of prompt_versions created.
 */
async function handleDuplicatePrompt(
  prisma: PrismaClient,
  workspaceId: string,
  existingImageId: string,
  record: ManifestRecord,
  label: string,
): Promise<number> {
  if (!record.hasPromptEn || !record.promptEn) return 0;
  try {
    const existingPrompt = await prisma.prompt.findFirst({
      where: { imageId: existingImageId },
      include: { versions: { select: { body: true } } },
    });
    if (!existingPrompt) return 0;

    const newBody = record.promptEn;
    const isDupe =
      existingPrompt.originalBody === newBody ||
      existingPrompt.currentBody === newBody ||
      existingPrompt.versions.some((v) => v.body === newBody);

    if (isDupe) {
      console.log(`[${label}] SKIP_PROMPT_VERSION (same body) row ${record.rowNumber}`);
      return 0;
    }
    await prisma.promptVersion.create({
      data: {
        workspaceId,
        promptId: existingPrompt.id,
        versionType: "EDIT",
        body: newBody,
        changeNote: `Imported duplicate prompt from ${record.sheetName} row ${record.rowNumber}`,
      },
    });
    return 1;
  } catch {
    return 0;
  }
}

/** Best-effort cleanup of orphaned Storage files after a failed DB write. */
async function cleanupOrphanedStorage(
  supabase: SupabaseClient,
  paths: (string | null)[],
  label: string,
  rowTag: string,
): Promise<void> {
  const toRemove = paths.filter((p): p is string => p !== null);
  if (toRemove.length === 0) return;
  try {
    const { error } = await supabase.storage.from(STORAGE_BUCKET).remove(toRemove);
    if (error) {
      console.warn(`[${label}] Storage cleanup warning ${rowTag}: ${error.message}`);
    }
  } catch (e) {
    console.warn(`[${label}] Storage cleanup failed ${rowTag}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export async function importManifest(
  opts: ImportManifestOptions,
  prisma: PrismaClient,
  supabase: SupabaseClient,
): Promise<ImportManifestResult> {
  const label = opts.batchLabel ?? path.basename(path.dirname(opts.manifestPath));

  // Read manifest
  const manifestRaw = await fs.readFile(opts.manifestPath, "utf-8");
  const manifest: Manifest = JSON.parse(manifestRaw) as Manifest;

  // Filter eligible records: hasImage=true, exclude status="missing_image"
  let eligible = manifest.records.filter(
    (r) => r.hasImage && r.status !== "missing_image",
  );

  // Apply limit
  if (opts.limit !== null) {
    eligible = eligible.slice(0, opts.limit);
  }

  const totalRecords = manifest.records.length;
  const eligibleCount = eligible.length;

  console.log(
    `[${label}] manifest: ${totalRecords} records, ${eligibleCount} eligible` +
      (opts.dryRun ? " (DRY RUN)" : ""),
  );

  // Result accumulators
  let imported = 0;
  let skippedDuplicate = 0;
  let skippedNoImage = 0;
  let errors = 0;
  let warningCount = 0;
  let promptVersionsCreated = 0;
  let totalUploadedBytes = 0;
  const errorDetails: Array<{ row: number; reason: string }> = [];
  const importedImages: Array<{ row: number; imageId: string; outputFileName: string }> = [];

  // ---------------------------------------------------------------------------
  // Pre-pass: compute all file hashes in parallel, then do a single bulk DB
  // lookup instead of one findFirst per record.
  //
  // For a 149-record import with ~143 duplicates this eliminates ~143 individual
  // DB round-trips (each ~5-20 ms) and replaces them with 1 findMany.
  // ---------------------------------------------------------------------------
  const prepassStart = Date.now();
  const prepassHashes = new Map<string, string>(); // outputFileName → fileHash

  await withConcurrency(eligible, opts.concurrency, async (record) => {
    const imagePath = path.join(opts.imagesDir, record.outputFileName);
    try {
      const buf = await fs.readFile(imagePath);
      prepassHashes.set(record.outputFileName, sha256(buf));
    } catch {
      // File-read errors are reported properly in the main loop below
    }
  });

  // Bulk DB lookup — chunk at 500 to stay within parameter limits
  const HASH_CHUNK_SIZE = 500;
  const allHashes = [...new Set(prepassHashes.values())];
  const existingByHash = new Map<string, string>(); // fileHash → imageId
  for (let i = 0; i < allHashes.length; i += HASH_CHUNK_SIZE) {
    const chunk = allHashes.slice(i, i + HASH_CHUNK_SIZE);
    const found = await prisma.image.findMany({
      where: { workspaceId: opts.workspaceId, fileHash: { in: chunk } },
      select: { id: true, fileHash: true },
    });
    for (const img of found) {
      if (img.fileHash) existingByHash.set(img.fileHash, img.id);
    }
  }

  const prepassMs = Date.now() - prepassStart;
  console.log(
    `[${label}] pre-pass: ${prepassHashes.size} hashes, ` +
    `${existingByHash.size} existing in DB, ${prepassMs}ms`,
  );

  // Promise-based in-flight dedup: fileHash → Promise<imageId | null>
  // Registering the promise BEFORE uploading prevents concurrent workers from
  // starting a second image.create for the same hash (P2002 race condition).
  // imageId = null means the insert failed with a non-recoverable error.
  const inFlight = new Map<string, Promise<string | null>>();

  // Pre-populate inFlight with DB-existing images so concurrent workers
  // that share a hash with an already-known duplicate skip immediately.
  for (const [hash, id] of existingByHash) {
    inFlight.set(hash, Promise.resolve(id));
  }

  // Create ImportBatch
  let batchId: string | null = null;
  if (!opts.dryRun) {
    const batch = await prisma.importBatch.create({
      data: {
        workspaceId: opts.workspaceId,
        userId: opts.userId,
        fileName: manifest.xlsxFile,
        fileType: "xlsx",
        rowCount: eligibleCount,
        importedCount: 0,
        skippedCount: 0,
        errorCount: 0,
        status: "PROCESSING",
      },
    });
    batchId = batch.id;
    console.log(`[${label}] ImportBatch created: ${batchId}`);
  }

  // Process records
  await withConcurrency(eligible, opts.concurrency, async (record) => {
    const rowTag = `row ${record.rowNumber}`;
    const imagePath = path.join(opts.imagesDir, record.outputFileName);

    // -----------------------------------------------------------------------
    // Fast duplicate skip using pre-pass hash (avoids file read for duplicates)
    //
    // inFlight was pre-populated from existingByHash (bulk DB lookup), so any
    // hash already in inFlight is either a known DB duplicate or a concurrent
    // in-progress upload. Skip immediately without reading the file.
    // -----------------------------------------------------------------------
    const prepassHash = prepassHashes.get(record.outputFileName);
    if (prepassHash && inFlight.has(prepassHash)) {
      const existingId = await inFlight.get(prepassHash)!;
      const resolvedId =
        existingId ??
        // Fallback: if original in-flight worker failed, verify DB state
        ((await prisma.image.findFirst({ where: { workspaceId: opts.workspaceId, fileHash: prepassHash } }))?.id ?? null);
      if (resolvedId) {
        console.log(
          `[${label}] SKIP_DUPLICATE (pre-pass) ${rowTag}: hash=${prepassHash.slice(0, 12)}… existingId=${resolvedId}`,
        );
        skippedDuplicate++;
        if (!opts.dryRun) {
          promptVersionsCreated += await handleDuplicatePrompt(prisma, opts.workspaceId, resolvedId, record, label);
        }
      } else {
        console.warn(`[${label}] SKIP (pre-pass original failed) ${rowTag}`);
        skippedDuplicate++;
      }
      return;
    }

    // Read image file (needed for upload, or when pre-pass couldn't hash this file)
    let imageBuffer: Buffer;
    try {
      imageBuffer = await fs.readFile(imagePath);
    } catch (err) {
      const reason = `Cannot read image file ${record.outputFileName}: ${err instanceof Error ? err.message : String(err)}`;
      console.warn(`[${label}] SKIP_NO_IMAGE ${rowTag}: ${reason}`);
      skippedNoImage++;
      errorDetails.push({ row: record.rowNumber, reason });
      errors++;
      return;
    }

    // Use pre-pass hash if available (avoids redundant SHA-256 for new images)
    const fileHash = prepassHash ?? sha256(imageBuffer);

    // -----------------------------------------------------------------------
    // In-flight dedup: guard against concurrent workers sharing the same hash
    // (P2002 prevention). Also catches late arrivals that missed the pre-pass.
    // -----------------------------------------------------------------------
    if (inFlight.has(fileHash)) {
      const existingId = await inFlight.get(fileHash)!;
      const resolvedId =
        existingId ??
        ((await prisma.image.findFirst({ where: { workspaceId: opts.workspaceId, fileHash } }))?.id ?? null);
      if (resolvedId) {
        console.log(`[${label}] SKIP_DUPLICATE (in-flight) ${rowTag}: hash=${fileHash.slice(0, 12)}… existingId=${resolvedId}`);
        skippedDuplicate++;
        if (!opts.dryRun) {
          promptVersionsCreated += await handleDuplicatePrompt(prisma, opts.workspaceId, resolvedId, record, label);
        }
      } else {
        console.warn(`[${label}] SKIP (in-flight original failed) ${rowTag}`);
        skippedDuplicate++;
      }
      return;
    }

    // -----------------------------------------------------------------------
    // DB dedup fallback — for hashes not covered by the pre-pass (file-read
    // failure during pre-pass). Keeps correctness when pre-pass is incomplete.
    // -----------------------------------------------------------------------
    const existingImage = await prisma.image.findFirst({
      where: { workspaceId: opts.workspaceId, fileHash },
    });
    if (existingImage) {
      console.log(
        `[${label}] SKIP_DUPLICATE (db-fallback) ${rowTag}: hash=${fileHash.slice(0, 12)}… existingId=${existingImage.id}`,
      );
      skippedDuplicate++;
      if (!opts.dryRun) {
        promptVersionsCreated += await handleDuplicatePrompt(prisma, opts.workspaceId, existingImage.id, record, label);
      }
      inFlight.set(fileHash, Promise.resolve(existingImage.id));
      return;
    }

    if (opts.dryRun) {
      console.log(`[${label}] DRY_RUN WOULD_IMPORT ${rowTag}: ${record.outputFileName}`);
      imported++;
      inFlight.set(fileHash, Promise.resolve(`dry-run-${record.rowNumber}`));
      return;
    }

    // -----------------------------------------------------------------------
    // Register a pending promise BEFORE uploading to prevent race conditions.
    // Any concurrent worker encountering the same hash will await this promise.
    // -----------------------------------------------------------------------
    let resolveInFlight!: (id: string | null) => void;
    const inFlightPromise = new Promise<string | null>((res) => { resolveInFlight = res; });
    inFlight.set(fileHash, inFlightPromise);

    // Generate image variants
    const variants = await generateVariants(imageBuffer);
    warningCount += variants.warnings.length;
    if (variants.warnings.length > 0) {
      console.warn(`[${label}] variant warnings ${rowTag}:`, variants.warnings.join("; "));
    }

    // Determine extension and mime
    const ext = path.extname(record.outputFileName).replace(".", "").toLowerCase() || "png";
    const mimeType = extToMime(ext);

    const imageId: string = (await import("cuid")).default();

    const storagePath = `${opts.workspaceId}/assets/${imageId}/original.${ext}`;
    const thumbnailPath = variants.thumbnailBuffer
      ? `${opts.workspaceId}/assets/${imageId}/thumbnail.webp`
      : null;
    const previewPath = variants.previewBuffer
      ? `${opts.workspaceId}/assets/${imageId}/preview.webp`
      : null;

    // Upload original
    const uploadOriginal = await uploadBuffer(
      supabase,
      STORAGE_BUCKET,
      storagePath,
      imageBuffer,
      mimeType,
    );
    if (!uploadOriginal.ok) {
      const reason = `Storage upload failed for original: ${uploadOriginal.message}`;
      console.error(`[${label}] ERROR ${rowTag}: ${reason}`);
      errors++;
      errorDetails.push({ row: record.rowNumber, reason });
      resolveInFlight(null);
      return;
    }
    totalUploadedBytes += imageBuffer.length;

    // Upload thumbnail
    if (variants.thumbnailBuffer && thumbnailPath) {
      const up = await uploadBuffer(
        supabase,
        STORAGE_BUCKET,
        thumbnailPath,
        variants.thumbnailBuffer,
        "image/webp",
      );
      if (up.ok) {
        totalUploadedBytes += variants.thumbnailBuffer.length;
      } else {
        warningCount++;
        console.warn(`[${label}] thumbnail upload failed ${rowTag}: ${up.message}`);
      }
    }

    // Upload preview
    if (variants.previewBuffer && previewPath) {
      const up = await uploadBuffer(
        supabase,
        STORAGE_BUCKET,
        previewPath,
        variants.previewBuffer,
        "image/webp",
      );
      if (up.ok) {
        totalUploadedBytes += variants.previewBuffer.length;
      } else {
        warningCount++;
        console.warn(`[${label}] preview upload failed ${rowTag}: ${up.message}`);
      }
    }

    // Compute derived text fields
    const notes = record.promptJa ? record.promptJa.slice(0, 10000) : null;
    const searchParts = [record.promptEn, record.promptJa].filter(Boolean);
    const searchText = searchParts.join(" ").slice(0, 2000) || null;
    const promptBody = record.promptEn || record.promptJa || "";

    // DB writes in transaction
    try {
      await prisma.$transaction(async (tx) => {
        // Create Image
        await tx.image.create({
          data: {
            id: imageId,
            workspaceId: opts.workspaceId,
            sceneId: opts.sceneId,
            storageBucket: STORAGE_BUCKET,
            storagePath,
            thumbnailPath,
            previewPath,
            originalName: record.outputFileName,
            originalExt: ext,
            mimeType,
            fileSizeBytes: imageBuffer.length,
            widthPx: variants.widthPx,
            heightPx: variants.heightPx,
            fileHash,
            isFavorite: false,
            notes,
            searchText,
            importBatchId: batchId,
            sourceSheetName: record.sheetName,
            sourceRow: record.rowNumber,
            sourceColumn: record.imageCol0,
          },
        });

        // Create Prompt (only if there's body text)
        if (promptBody) {
          await tx.prompt.create({
            data: {
              workspaceId: opts.workspaceId,
              imageId,
              originalBody: promptBody,
              currentBody: promptBody,
            },
          });
        }

        // Create ImagePerson
        if (opts.personId) {
          await tx.imagePerson.create({
            data: {
              imageId,
              personId: opts.personId,
              workspaceId: opts.workspaceId,
            },
          });
        }

        // Create ImageTags
        for (const tagId of opts.tagIds) {
          await tx.imageTag.create({
            data: {
              imageId,
              tagId,
              workspaceId: opts.workspaceId,
            },
          });
        }
      });

      // Success
      resolveInFlight(imageId);
      imported++;
      importedImages.push({ row: record.rowNumber, imageId, outputFileName: record.outputFileName });
      console.log(`[${label}] IMPORTED ${rowTag}: imageId=${imageId}`);

    } catch (err) {
      // -----------------------------------------------------------------------
      // P2002 recovery: unique constraint on (workspace_id, file_hash)
      // This means a concurrent worker inserted the same image between our DB
      // check and our insert. Treat as duplicate skip (not an error).
      // -----------------------------------------------------------------------
      if (isP2002(err)) {
        const conflictingImage = await prisma.image.findFirst({
          where: { workspaceId: opts.workspaceId, fileHash },
        });
        if (conflictingImage) {
          console.log(
            `[${label}] SKIP_DUPLICATE (P2002 recovery) ${rowTag}: existingId=${conflictingImage.id}`,
          );
          resolveInFlight(conflictingImage.id);
          skippedDuplicate++;
          // Cleanup orphaned storage files (uploaded but DB insert rejected)
          await cleanupOrphanedStorage(
            supabase,
            [storagePath, thumbnailPath, previewPath],
            label,
            rowTag,
          );
          // Handle prompt_versions
          promptVersionsCreated += await handleDuplicatePrompt(
            prisma, opts.workspaceId, conflictingImage.id, record, label,
          );
          return;
        }
      }

      // Non-recoverable error
      const reason = `DB write failed: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[${label}] ERROR ${rowTag}: ${reason}`);
      errors++;
      errorDetails.push({ row: record.rowNumber, reason });
      resolveInFlight(null);
    }
  });

  // Update ImportBatch
  if (!opts.dryRun && batchId) {
    const status = errors > 0 && imported === 0 ? "FAILED" : "DONE";
    await prisma.importBatch.update({
      where: { id: batchId },
      data: {
        importedCount: imported,
        skippedCount: skippedDuplicate + skippedNoImage,
        errorCount: errors,
        status,
        errorLog: errorDetails.length > 0 ? JSON.stringify(errorDetails) : null,
      },
    });
  }

  return {
    batchId,
    imported,
    skippedDuplicate,
    skippedNoImage,
    errors,
    warningCount,
    promptVersionsCreated,
    totalUploadedBytes,
    errorDetails,
    importedImages,
  };
}
