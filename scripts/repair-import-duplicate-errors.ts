/**
 * repair-import-duplicate-errors.ts
 *
 * Finds ImportBatch records whose errorLog contains "Unique constraint failed"
 * on (workspace_id, file_hash), then reclassifies each affected row as a
 * duplicate skip instead of an error.
 *
 * Usage:
 *   npm run repair:import-duplicates -- --workspace-id <id> --extract-root <dir> [--dry-run] [--yes]
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { loadEnv, createPrisma } from "./_lib/clients";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  workspaceId: string | null;
  extractRoot: string;
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
    workspaceId: get("--workspace-id"),
    extractRoot: get("--extract-root") ?? "tmp/xlsx-extract",
    dryRun: has("--dry-run"),
    yes: has("--yes"),
  };
}

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(prompt, resolve));
  rl.close();
  return answer.trim().toLowerCase() === "yes";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ErrorLogEntry {
  row: number;
  reason: string;
}

interface ManifestRecord {
  rowNumber: number;
  sheetName: string;
  outputFileName: string;
  hasPromptEn: boolean;
  promptEn: string;
  hasPromptJa: boolean;
  promptJa: string;
  hasImage: boolean;
  status: string;
}

interface Manifest {
  xlsxFile: string;
  records: ManifestRecord[];
}

interface RepairCandidate {
  batchId: string;
  fileName: string;
  errorEntry: ErrorLogEntry;
  manifestPath: string | null;
  imagesDir: string | null;
}

interface RepairResult {
  batchId: string;
  row: number;
  fileName: string;
  outcome:
    | "repaired_skip"
    | "repaired_skip_with_prompt_version"
    | "not_unique_constraint"
    | "no_manifest"
    | "no_image_file"
    | "no_existing_image"
    | "error";
  existingImageId?: string;
  promptVersionCreated?: boolean;
  detail?: string;
}

// ---------------------------------------------------------------------------
// Scan extract-root for manifests indexed by xlsxFile name
// ---------------------------------------------------------------------------

async function buildManifestIndex(
  extractRoot: string,
): Promise<Map<string, { manifestPath: string; imagesDir: string }>> {
  const index = new Map<string, { manifestPath: string; imagesDir: string }>();
  let entries: string[];
  try {
    entries = await fs.readdir(extractRoot);
  } catch {
    return index;
  }
  for (const entry of entries) {
    const dir = path.join(extractRoot, entry);
    const stat = await fs.stat(dir).catch(() => null);
    if (!stat?.isDirectory()) continue;
    const manifestPath = path.join(dir, "manifest.json");
    try {
      const raw = await fs.readFile(manifestPath, "utf-8");
      const manifest = JSON.parse(raw) as Manifest;
      index.set(manifest.xlsxFile, {
        manifestPath,
        imagesDir: path.join(dir, "images"),
      });
    } catch {
      // skip dirs without valid manifest
    }
  }
  return index;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnv();

  const args = parseArgs(process.argv);

  if (!args.workspaceId) {
    console.error(`
Usage: npm run repair:import-duplicates -- \\
  --workspace-id <id>        Required
  --extract-root <dir>       Default: tmp/xlsx-extract
  --dry-run
  --yes
`);
    process.exit(1);
  }

  const workspaceId: string = args.workspaceId;
  const extractRoot = path.resolve(args.extractRoot);

  const prisma = createPrisma();

  try {
    // -----------------------------------------------------------------------
    // Find ImportBatch records with unique-constraint errors in errorLog
    // -----------------------------------------------------------------------
    const batches = await prisma.importBatch.findMany({
      where: { workspaceId, errorLog: { not: null } },
      select: { id: true, fileName: true, errorLog: true, errorCount: true, skippedCount: true },
    });

    // Parse errorLog and filter for unique-constraint file_hash errors
    const candidates: RepairCandidate[] = [];
    const manifestIndex = await buildManifestIndex(extractRoot);

    for (const batch of batches) {
      if (!batch.errorLog) continue;

      let entries: ErrorLogEntry[];
      try {
        entries = JSON.parse(batch.errorLog) as ErrorLogEntry[];
      } catch {
        continue;
      }

      for (const entry of entries) {
        const isUniqueConstraint =
          entry.reason.includes("Unique constraint failed") &&
          entry.reason.includes("file_hash");

        if (!isUniqueConstraint) continue;

        const manifestInfo = manifestIndex.get(batch.fileName);
        candidates.push({
          batchId: batch.id,
          fileName: batch.fileName,
          errorEntry: entry,
          manifestPath: manifestInfo?.manifestPath ?? null,
          imagesDir: manifestInfo?.imagesDir ?? null,
        });
      }
    }

    if (candidates.length === 0) {
      console.log("No repairable unique-constraint errors found in import batches.");
      return;
    }

    console.log(`\nFound ${candidates.length} repairable error(s):\n`);

    // -----------------------------------------------------------------------
    // Resolve each candidate
    // -----------------------------------------------------------------------
    const results: RepairResult[] = [];

    for (const c of candidates) {
      const rowTag = `${c.fileName} row ${c.errorEntry.row}`;

      // Check manifest availability
      if (!c.manifestPath || !c.imagesDir) {
        console.log(`  [NO_MANIFEST] ${rowTag}`);
        results.push({
          batchId: c.batchId,
          row: c.errorEntry.row,
          fileName: c.fileName,
          outcome: "no_manifest",
          detail: `Manifest not found in extract-root for file: ${c.fileName}`,
        });
        continue;
      }

      // Read manifest and find record
      let manifest: Manifest;
      try {
        manifest = JSON.parse(await fs.readFile(c.manifestPath, "utf-8")) as Manifest;
      } catch (e) {
        results.push({
          batchId: c.batchId,
          row: c.errorEntry.row,
          fileName: c.fileName,
          outcome: "error",
          detail: `Cannot read manifest: ${e instanceof Error ? e.message : String(e)}`,
        });
        continue;
      }

      const record = manifest.records.find((r) => r.rowNumber === c.errorEntry.row);
      if (!record) {
        results.push({
          batchId: c.batchId,
          row: c.errorEntry.row,
          fileName: c.fileName,
          outcome: "error",
          detail: `Row ${c.errorEntry.row} not found in manifest`,
        });
        continue;
      }

      // Read image file and compute hash
      const imagePath = path.join(c.imagesDir, record.outputFileName);
      let imageBuffer: Buffer;
      try {
        imageBuffer = await fs.readFile(imagePath);
      } catch {
        console.log(`  [NO_IMAGE_FILE] ${rowTag}: ${record.outputFileName}`);
        results.push({
          batchId: c.batchId,
          row: c.errorEntry.row,
          fileName: c.fileName,
          outcome: "no_image_file",
          detail: `Image file not found: ${record.outputFileName}`,
        });
        continue;
      }

      const fileHash = sha256(imageBuffer);

      // Find existing image by hash
      const existingImage = await prisma.image.findFirst({
        where: { workspaceId, fileHash },
      });

      if (!existingImage) {
        console.log(`  [NO_EXISTING_IMAGE] ${rowTag}: hash=${fileHash.slice(0, 12)}…`);
        results.push({
          batchId: c.batchId,
          row: c.errorEntry.row,
          fileName: c.fileName,
          outcome: "no_existing_image",
          detail: `No existing image found for hash=${fileHash.slice(0, 12)}…`,
        });
        continue;
      }

      // Determine if prompt_version is needed
      let promptVersionNeeded = false;
      let promptVersionBody: string | null = null;
      if (record.hasPromptEn && record.promptEn) {
        const existingPrompt = await prisma.prompt.findFirst({
          where: { imageId: existingImage.id },
          include: { versions: { select: { body: true } } },
        });
        if (existingPrompt) {
          const newBody = record.promptEn;
          const isDupe =
            existingPrompt.originalBody === newBody ||
            existingPrompt.currentBody === newBody ||
            existingPrompt.versions.some((v) => v.body === newBody);
          if (!isDupe) {
            promptVersionNeeded = true;
            promptVersionBody = newBody;
          }
        }
      }

      console.log(`  [REPAIRABLE] ${rowTag}`);
      console.log(`    existingImageId: ${existingImage.id}`);
      console.log(`    hash:            ${fileHash.slice(0, 12)}…`);
      console.log(`    promptVersion:   ${promptVersionNeeded ? "will create" : "not needed"}`);

      results.push({
        batchId: c.batchId,
        row: c.errorEntry.row,
        fileName: c.fileName,
        outcome: promptVersionNeeded ? "repaired_skip_with_prompt_version" : "repaired_skip",
        existingImageId: existingImage.id,
        promptVersionCreated: false,
        detail: promptVersionBody ?? undefined,
      });
    }

    // -----------------------------------------------------------------------
    // Dry run: stop here
    // -----------------------------------------------------------------------
    const repairableCount = results.filter(
      (r) => r.outcome === "repaired_skip" || r.outcome === "repaired_skip_with_prompt_version",
    ).length;

    console.log(`\n--- Repair Summary (DRY RUN: ${args.dryRun}) ---`);
    console.log(`Total errors found:     ${candidates.length}`);
    console.log(`Repairable:             ${repairableCount}`);
    console.log(`No manifest:            ${results.filter((r) => r.outcome === "no_manifest").length}`);
    console.log(`No image file:          ${results.filter((r) => r.outcome === "no_image_file").length}`);
    console.log(`No existing image:      ${results.filter((r) => r.outcome === "no_existing_image").length}`);
    console.log(`Other errors:           ${results.filter((r) => r.outcome === "error").length}`);

    if (args.dryRun) {
      console.log("\n[DRY RUN] No changes made.\n");
      return;
    }

    if (repairableCount === 0) {
      console.log("\nNothing to repair.\n");
      return;
    }

    if (!args.yes) {
      const ok = await confirm(`\nRepair ${repairableCount} error(s)? (yes/no): `);
      if (!ok) {
        console.log("Aborted.");
        return;
      }
    }

    // -----------------------------------------------------------------------
    // Execute repairs
    // -----------------------------------------------------------------------
    console.log(`\nExecuting repairs...\n`);

    // Group results by batchId for efficient batch updates
    const byBatch = new Map<string, typeof results>();
    for (const r of results) {
      if (!byBatch.has(r.batchId)) byBatch.set(r.batchId, []);
      byBatch.get(r.batchId)!.push(r);
    }

    let totalPromptVersionsCreated = 0;
    let totalRepaired = 0;

    for (const [batchId, batchResults] of byBatch) {
      const batch = await prisma.importBatch.findUnique({
        where: { id: batchId },
        select: { errorLog: true, errorCount: true, skippedCount: true, fileName: true },
      });
      if (!batch) continue;

      let currentErrorLog: ErrorLogEntry[] = [];
      try {
        if (batch.errorLog) currentErrorLog = JSON.parse(batch.errorLog) as ErrorLogEntry[];
      } catch { /* empty */ }

      let repairedInBatch = 0;
      let promptVersionsInBatch = 0;

      for (const result of batchResults) {
        if (result.outcome !== "repaired_skip" && result.outcome !== "repaired_skip_with_prompt_version") {
          continue;
        }

        // Create prompt_version if needed
        if (result.outcome === "repaired_skip_with_prompt_version" && result.existingImageId && result.detail) {
          try {
            const existingPrompt = await prisma.prompt.findFirst({
              where: { imageId: result.existingImageId },
              include: { versions: { select: { body: true } } },
            });
            if (existingPrompt) {
              const newBody = result.detail;
              const isDupe =
                existingPrompt.originalBody === newBody ||
                existingPrompt.currentBody === newBody ||
                existingPrompt.versions.some((v) => v.body === newBody);
              if (!isDupe) {
                // Find the manifest record for sheetName
                const candidateForRow = candidates.find(
                  (c) => c.batchId === batchId && c.errorEntry.row === result.row,
                );
                let sheetName = batch.fileName;
                if (candidateForRow?.manifestPath) {
                  try {
                    const m = JSON.parse(await fs.readFile(candidateForRow.manifestPath, "utf-8")) as Manifest;
                    const rec = m.records.find((r) => r.rowNumber === result.row);
                    if (rec) sheetName = rec.sheetName;
                  } catch { /* use fileName as fallback */ }
                }

                await prisma.promptVersion.create({
                  data: {
                    workspaceId,
                    promptId: existingPrompt.id,
                    versionType: "EDIT",
                    body: newBody,
                    changeNote: `Repaired duplicate prompt from ${sheetName} row ${result.row}`,
                  },
                });
                result.promptVersionCreated = true;
                promptVersionsInBatch++;
                totalPromptVersionsCreated++;
              }
            }
          } catch (e) {
            console.warn(`  Warning: prompt_version creation failed for row ${result.row}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        // Remove this error from errorLog
        currentErrorLog = currentErrorLog.filter(
          (e) => !(e.row === result.row && e.reason.includes("Unique constraint failed") && e.reason.includes("file_hash")),
        );

        repairedInBatch++;
        totalRepaired++;
        console.log(`  REPAIRED: ${result.fileName} row ${result.row}  existingId=${result.existingImageId}${result.promptVersionCreated ? "  +prompt_version" : ""}`);
      }

      // Update ImportBatch: adjust errorCount / skippedCount / errorLog
      const newErrorCount = Math.max(0, (batch.errorCount ?? 0) - repairedInBatch);
      const newSkippedCount = (batch.skippedCount ?? 0) + repairedInBatch;
      const newErrorLog = currentErrorLog.length > 0 ? JSON.stringify(currentErrorLog) : null;

      await prisma.importBatch.update({
        where: { id: batchId },
        data: {
          errorCount: newErrorCount,
          skippedCount: newSkippedCount,
          errorLog: newErrorLog,
        },
      });

      console.log(
        `  ImportBatch ${batchId}: errorCount ${batch.errorCount} → ${newErrorCount}, skippedCount ${batch.skippedCount} → ${newSkippedCount}`,
      );
      if (promptVersionsInBatch > 0) {
        console.log(`  prompt_versions created: ${promptVersionsInBatch}`);
      }
    }

    // -----------------------------------------------------------------------
    // Final report
    // -----------------------------------------------------------------------
    console.log(`\n=== Repair Complete ===`);
    console.log(`Errors repaired:          ${totalRepaired}`);
    console.log(`Prompt versions created:  ${totalPromptVersionsCreated}`);
    console.log(`\nVerify with:`);
    console.log(`  SELECT id, file_name, error_count, skipped_count FROM import_batches WHERE workspace_id = '${workspaceId}' ORDER BY created_at;`);
    console.log(`=======================\n`);

  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
