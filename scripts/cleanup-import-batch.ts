/**
 * cleanup-import-batch.ts
 *
 * Deletes a test import batch: Storage files + Image rows + ImportBatch record.
 * Only removes images that belong to the specified importBatchId — never touches
 * Quick Add data or images from other batches.
 *
 * Usage:
 *   npm run cleanup:import-batch -- --import-batch-id <id> [--dry-run] [--yes]
 */

import readline from "node:readline";
import { loadEnv, createSupabaseAdmin, createPrisma } from "./_lib/clients";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  importBatchId: string | null;
  dryRun: boolean;
  yes: boolean;
} {
  const args = argv.slice(2);
  const get = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
  };
  const has = (flag: string): boolean => args.includes(flag);

  return {
    importBatchId: get("--import-batch-id"),
    dryRun: has("--dry-run"),
    yes: has("--yes"),
  };
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

async function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(prompt, resolve));
  rl.close();
  return answer.trim().toLowerCase() === "yes";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnv();

  const args = parseArgs(process.argv);

  if (!args.importBatchId) {
    console.error(`
Usage: npm run cleanup:import-batch -- --import-batch-id <id> [--dry-run] [--yes]

  --import-batch-id <id>   Required. ImportBatch ID to delete.
  --dry-run                Show what would be deleted, no actual writes.
  --yes                    Skip interactive confirmation.
`);
    process.exit(1);
  }

  const prisma = createPrisma();
  const supabase = createSupabaseAdmin();

  try {
    // Fetch the ImportBatch
    const batch = await prisma.importBatch.findUnique({
      where: { id: args.importBatchId },
    });

    if (!batch) {
      console.error(`Error: ImportBatch not found: ${args.importBatchId}`);
      process.exit(1);
    }

    // Fetch all images linked to this batch
    const images = await prisma.image.findMany({
      where: { importBatchId: args.importBatchId },
      select: {
        id: true,
        storageBucket: true,
        storagePath: true,
        thumbnailPath: true,
        previewPath: true,
        originalName: true,
      },
    });

    // Build full list of Storage paths to delete
    const storagePaths: string[] = [];
    for (const img of images) {
      storagePaths.push(img.storagePath);
      if (img.thumbnailPath) storagePaths.push(img.thumbnailPath);
      if (img.previewPath) storagePaths.push(img.previewPath);
    }

    // Summary
    console.log(`\n--- Cleanup Plan ---`);
    console.log(`ImportBatch ID:  ${batch.id}`);
    console.log(`Workspace ID:    ${batch.workspaceId}`);
    console.log(`File:            ${batch.fileName}`);
    console.log(`Status:          ${batch.status}`);
    console.log(`Images to delete: ${images.length}`);
    console.log(`Storage paths:   ${storagePaths.length}`);
    console.log(`Dry run:         ${args.dryRun}`);
    console.log(`--------------------`);

    if (images.length > 0) {
      console.log(`\nFirst images:`);
      images.slice(0, 5).forEach((img) => {
        console.log(`  ${img.id}  ${img.originalName}`);
        console.log(`    original:  ${img.storagePath}`);
        if (img.thumbnailPath) console.log(`    thumbnail: ${img.thumbnailPath}`);
        if (img.previewPath)   console.log(`    preview:   ${img.previewPath}`);
      });
      if (images.length > 5) {
        console.log(`  ... and ${images.length - 5} more`);
      }
    }

    if (args.dryRun) {
      console.log(`\n[DRY RUN] No changes made.`);
      return;
    }

    if (!args.yes) {
      const ok = await confirm(`\nDelete ${images.length} images and ImportBatch ${batch.id}? (yes/no): `);
      if (!ok) {
        console.log("Aborted.");
        return;
      }
    }

    // ---------------------------------------------------------------------------
    // Delete Storage files
    // ---------------------------------------------------------------------------
    const STORAGE_BUCKET = "photobox-private";
    let storageDeleteOk = 0;
    let storageDeleteFail = 0;

    if (storagePaths.length > 0) {
      console.log(`\nDeleting ${storagePaths.length} Storage files...`);

      // Supabase Storage remove accepts up to ~1000 paths per call; batch in chunks of 100
      const CHUNK_SIZE = 100;
      for (let i = 0; i < storagePaths.length; i += CHUNK_SIZE) {
        const chunk = storagePaths.slice(i, i + CHUNK_SIZE);
        const { error } = await supabase.storage.from(STORAGE_BUCKET).remove(chunk);
        if (error) {
          console.warn(`  Storage remove error (chunk ${i / CHUNK_SIZE + 1}): ${error.message}`);
          storageDeleteFail += chunk.length;
        } else {
          storageDeleteOk += chunk.length;
        }
      }

      console.log(`  Deleted: ${storageDeleteOk}  Failed: ${storageDeleteFail}`);
    }

    // ---------------------------------------------------------------------------
    // Delete Image rows (cascade: prompts, prompt_versions, image_tags, image_persons)
    // ---------------------------------------------------------------------------
    let imageDeleteCount = 0;
    if (images.length > 0) {
      console.log(`\nDeleting ${images.length} Image rows (cascade)...`);
      const deleteResult = await prisma.image.deleteMany({
        where: { importBatchId: args.importBatchId },
      });
      imageDeleteCount = deleteResult.count;
      console.log(`  Deleted: ${imageDeleteCount} images`);
    }

    // ---------------------------------------------------------------------------
    // Delete ImportBatch
    // ---------------------------------------------------------------------------
    await prisma.importBatch.delete({
      where: { id: args.importBatchId },
    });
    console.log(`\nImportBatch deleted: ${args.importBatchId}`);

    // ---------------------------------------------------------------------------
    // Summary
    // ---------------------------------------------------------------------------
    console.log(`\n=== Cleanup Complete ===`);
    console.log(`Images deleted:        ${imageDeleteCount}`);
    console.log(`Storage files deleted: ${storageDeleteOk}`);
    if (storageDeleteFail > 0) {
      console.log(`Storage delete fails:  ${storageDeleteFail}  (files may already be gone)`);
    }
    console.log(`ImportBatch removed:   ${args.importBatchId}`);
    console.log(`=======================\n`);

  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
