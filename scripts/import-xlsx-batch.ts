/**
 * import-xlsx-batch.ts
 *
 * Batch XLSX import CLI — scans a root directory for manifest.json files
 * and imports each one using the shared importManifest logic.
 *
 * Usage:
 *   npm run import:xlsx-batch -- \
 *     --workspace-id <id>              (required)
 *     [--extract-root <dir>]           default: tmp/xlsx-extract
 *     [--user-id <id>]
 *     [--person-from-sheet-name]
 *     [--scene <name>]
 *     [--tags <tag1,tag2>]
 *     [--dry-run]
 *     [--yes]
 *     [--limit-files <N>]
 *     [--skip-existing]                default true
 *     [--concurrency-files <N>]        default 1
 *     [--concurrency-images <N>]       default 3
 */

import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { loadEnv, createSupabaseAdmin, createPrisma } from "./_lib/clients";
import { importManifest } from "./_lib/importManifest";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  extractRoot: string;
  workspaceId: string;
  userId: string | null;
  personFromSheetName: boolean;
  scene: string | null;
  tags: string[];
  dryRun: boolean;
  yes: boolean;
  limitFiles: number | null;
  only: string | null;
  skipExisting: boolean;
  concurrencyFiles: number;
  concurrencyImages: number;
}

function printUsage(): void {
  console.error(`
Usage: npx tsx scripts/import-xlsx-batch.ts \\
  --workspace-id <id>              Workspace ID (required)
  [--extract-root <dir>]           Directory to scan (default: tmp/xlsx-extract)
  [--user-id <id>]                 User ID (if omitted, looks up workspace owner)
  [--person-from-sheet-name]       Use manifest.sheetName as person name
  [--scene <name>]                 Upsert scene for all imports
  [--tags <tag1,tag2>]             Comma-separated tag names for all imports
  [--dry-run]                      List manifests and counts, no writes
  [--yes]                          Skip interactive confirmation
  [--limit-files <N>]              Process only first N manifest files
  [--only <partial-name>]          Process only the manifest matching this partial XLSX filename
  [--skip-existing]                Skip files already imported (default: true)
  [--no-skip-existing]             Force re-import even if batch exists
  [--concurrency-files <N>]        File-level concurrency (default: 1)
  [--concurrency-images <N>]       Image-level concurrency per file (default: 3)
`);
}

function parseArgs(argv: string[]): CliArgs | null {
  const args = argv.slice(2);
  const get = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
  };
  const has = (flag: string): boolean => args.includes(flag);

  const workspaceId = get("--workspace-id");
  if (!workspaceId) return null;

  const tagsRaw = get("--tags");
  const tags = tagsRaw ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean) : [];

  const limitFilesRaw = get("--limit-files");
  const limitFiles = limitFilesRaw !== null ? parseInt(limitFilesRaw, 10) : null;

  const concurrencyFilesRaw = parseInt(get("--concurrency-files") ?? "1", 10);
  const concurrencyFiles = Math.max(isNaN(concurrencyFilesRaw) ? 1 : concurrencyFilesRaw, 1);

  const concurrencyImagesRaw = parseInt(get("--concurrency-images") ?? "3", 10);
  const concurrencyImages = Math.min(
    Math.max(isNaN(concurrencyImagesRaw) ? 3 : concurrencyImagesRaw, 1),
    8,
  );

  // --skip-existing is default true; --no-skip-existing overrides
  const skipExisting = !has("--no-skip-existing");

  return {
    extractRoot: get("--extract-root") ?? "tmp/xlsx-extract",
    workspaceId,
    userId: get("--user-id"),
    personFromSheetName: has("--person-from-sheet-name"),
    scene: get("--scene"),
    tags,
    dryRun: has("--dry-run"),
    yes: has("--yes"),
    limitFiles: limitFiles !== null && !isNaN(limitFiles) ? limitFiles : null,
    only: get("--only"),
    skipExisting,
    concurrencyFiles,
    concurrencyImages,
  };
}

// ---------------------------------------------------------------------------
// Manifest meta type
// ---------------------------------------------------------------------------

interface ManifestMeta {
  xlsxFile: string;
  sheetName: string;
  recordCount: number;
  readyCount: number;
}

// ---------------------------------------------------------------------------
// Scan extract root for manifest.json files
// ---------------------------------------------------------------------------

async function scanManifests(
  extractRoot: string,
): Promise<Array<{ dir: string; manifestPath: string; meta: ManifestMeta }>> {
  const results: Array<{ dir: string; manifestPath: string; meta: ManifestMeta }> = [];

  let entries: string[];
  try {
    entries = await fs.readdir(extractRoot);
  } catch {
    console.error(`Error: Cannot read extract-root directory: ${extractRoot}`);
    return results;
  }

  for (const entry of entries) {
    const dir = path.join(extractRoot, entry);
    const stat = await fs.stat(dir).catch(() => null);
    if (!stat?.isDirectory()) continue;

    const manifestPath = path.join(dir, "manifest.json");
    try {
      await fs.access(manifestPath);
      const raw = await fs.readFile(manifestPath, "utf-8");
      const meta = JSON.parse(raw) as ManifestMeta;
      results.push({ dir, manifestPath, meta });
    } catch {
      // No manifest.json in this dir, skip
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Interactive confirmation
// ---------------------------------------------------------------------------

async function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(prompt, resolve));
  rl.close();
  return answer.trim().toLowerCase() === "yes";
}

// ---------------------------------------------------------------------------
// Run tasks with bounded concurrency
// ---------------------------------------------------------------------------

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
  const workers = Array.from({ length: Math.min(concurrency, items.length || 1) }, () => worker());
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnv();

  const args = parseArgs(process.argv);
  if (!args) {
    printUsage();
    process.exit(1);
  }

  const extractRoot = path.resolve(args.extractRoot);

  // Scan for manifests
  let manifests = await scanManifests(extractRoot);
  if (manifests.length === 0) {
    console.log(`No manifest.json files found in: ${extractRoot}`);
    process.exit(0);
  }

  // Apply --only (partial match on xlsxFile name)
  if (args.only !== null) {
    const pattern = args.only.toLowerCase();
    const matched = manifests.filter((m) =>
      m.meta.xlsxFile.toLowerCase().includes(pattern),
    );
    if (matched.length === 0) {
      console.error(`Error: --only "${args.only}" matched no manifests.`);
      console.error(`Available XLSX files:`);
      manifests.forEach((m) => console.error(`  ${m.meta.xlsxFile}`));
      process.exit(1);
    }
    if (matched.length > 1) {
      console.error(`Error: --only "${args.only}" matched multiple manifests. Please be more specific:`);
      matched.forEach((m) => console.error(`  ${m.meta.xlsxFile}`));
      process.exit(1);
    }
    console.log(`\n🎯 --only: matched "${matched[0].meta.xlsxFile}"`);
    manifests = matched;
  }

  // Apply --limit-files
  if (args.limitFiles !== null) {
    manifests = manifests.slice(0, args.limitFiles);
  }

  // Create clients
  const prisma = createPrisma();
  const supabase = createSupabaseAdmin();

  try {
    // ---------------------------------------------------------------------------
    // Resolve userId
    // ---------------------------------------------------------------------------
    let userId: string;
    let userIdSource: "explicit" | "owner_role";
    if (args.userId) {
      userId = args.userId;
      userIdSource = "explicit";
    } else {
      // Accept both "owner" (canonical) and "OWNER" (legacy) roles
      const owners = await prisma.workspaceMember.findMany({
        where: {
          workspaceId: args.workspaceId,
          role: { in: ["owner", "OWNER"] },
        },
      });
      if (owners.length === 0) {
        console.error(
          `Error: No owner found for workspace ${args.workspaceId}.\n` +
          `  Run: UPDATE workspace_members SET role = 'owner' WHERE role = 'OWNER';\n` +
          `  Or pass --user-id explicitly.`
        );
        process.exit(1);
      }
      if (owners.length > 1) {
        console.error(
          `Error: Multiple owners found (${owners.map((o) => o.userId).join(", ")}).\n` +
          `  Pass --user-id to specify which user.`
        );
        process.exit(1);
      }
      userId = owners[0].userId;
      userIdSource = "owner_role";
    }
    console.log(`WorkspaceId:   ${args.workspaceId}`);
    console.log(`UserId:        ${userId}  (resolved via: ${userIdSource})`);

    // ---------------------------------------------------------------------------
    // Resolve scene → sceneId
    // ---------------------------------------------------------------------------
    let sceneId: string | null = null;
    if (args.scene && !args.dryRun) {
      const scene = await prisma.scene.upsert({
        where: { workspaceId_name: { workspaceId: args.workspaceId, name: args.scene } },
        create: { workspaceId: args.workspaceId, name: args.scene },
        update: {},
      });
      sceneId = scene.id;
      console.log(`Scene upserted: "${args.scene}" (${sceneId})`);
    }

    // ---------------------------------------------------------------------------
    // Resolve tags → tagIds
    // ---------------------------------------------------------------------------
    const tagIds: string[] = [];
    if (args.tags.length > 0 && !args.dryRun) {
      for (const tagName of args.tags) {
        const tag = await prisma.tag.upsert({
          where: { workspaceId_name: { workspaceId: args.workspaceId, name: tagName } },
          create: { workspaceId: args.workspaceId, name: tagName },
          update: {},
        });
        tagIds.push(tag.id);
        console.log(`Tag upserted: "${tagName}" (${tag.id})`);
      }
    }

    // ---------------------------------------------------------------------------
    // Determine skip/block status for each manifest (always — dry-run and real)
    // ---------------------------------------------------------------------------

    type EntryStatus =
      | "WOULD_IMPORT"
      | "WILL_SKIP_DONE"
      | "BLOCKED_PROCESSING"
      | "BLOCKED_FAILED";

    interface ManifestEntry {
      dir: string;
      manifestPath: string;
      meta: ManifestMeta;
      status: EntryStatus;
      existingBatchId: string | null;
      personId: string | null;
      personName: string | null;
    }

    const entries: ManifestEntry[] = [];
    let hasBlockers = false;

    for (const m of manifests) {
      // Always query DB — even in dry-run — so we show accurate status
      const existingBatches = await prisma.importBatch.findMany({
        where: { workspaceId: args.workspaceId, fileName: m.meta.xlsxFile },
        select: { id: true, status: true },
        orderBy: { createdAt: "desc" },
      });

      let entryStatus: EntryStatus = "WOULD_IMPORT";
      let existingBatchId: string | null = null;

      for (const b of existingBatches) {
        if (b.status === "DONE" && args.skipExisting) {
          entryStatus = "WILL_SKIP_DONE";
          existingBatchId = b.id;
          break;
        }
        if (b.status === "PROCESSING") {
          entryStatus = "BLOCKED_PROCESSING";
          existingBatchId = b.id;
          hasBlockers = true;
          break;
        }
        if (b.status === "FAILED") {
          entryStatus = "BLOCKED_FAILED";
          existingBatchId = b.id;
          hasBlockers = true;
          break;
        }
      }

      // Resolve person per manifest (from sheet name)
      let personId: string | null = null;
      let personName: string | null = null;
      if (args.personFromSheetName && m.meta.sheetName) {
        personName = m.meta.sheetName;
        if (!args.dryRun && entryStatus === "WOULD_IMPORT") {
          const person = await prisma.person.upsert({
            where: {
              workspaceId_name: { workspaceId: args.workspaceId, name: personName },
            },
            create: { workspaceId: args.workspaceId, name: personName },
            update: {},
          });
          personId = person.id;
        }
      }

      entries.push({ ...m, status: entryStatus, existingBatchId, personId, personName });
    }

    // ---------------------------------------------------------------------------
    // Dry run: list status per manifest and totals
    // ---------------------------------------------------------------------------
    if (args.dryRun) {
      console.log("\n--- Batch Dry Run ---");
      console.log(`Person mode:   ${args.personFromSheetName ? "sheet name (per manifest)" : "(none)"}`);
      console.log(`Scene:         ${args.scene ?? "(none)"}`);
      console.log(`Tags:          ${args.tags.length > 0 ? args.tags.join(", ") : "(none)"}`);
      console.log("");

      let wouldImportCount = 0;
      let wouldImportRecords = 0;

      for (const e of entries) {
        let label: string;
        switch (e.status) {
          case "WILL_SKIP_DONE":
            label = `WILL_SKIP_DONE            (batchId: ${e.existingBatchId})`;
            break;
          case "BLOCKED_PROCESSING":
            label = `WARNING_PROCESSING_EXISTS (batchId: ${e.existingBatchId})`;
            break;
          case "BLOCKED_FAILED":
            label = `WARNING_FAILED_EXISTS     (batchId: ${e.existingBatchId})`;
            break;
          default:
            label = "WOULD_IMPORT             ";
            wouldImportCount++;
            wouldImportRecords += e.meta.recordCount;
        }
        const personSuffix = e.personName ? `  person="${e.personName}"` : "";
        console.log(
          `  ${label}  ${e.meta.xlsxFile}  (${e.meta.recordCount} records)${personSuffix}`,
        );
      }

      const skipCount = entries.filter((e) => e.status === "WILL_SKIP_DONE").length;
      const blockCount = entries.filter(
        (e) => e.status === "BLOCKED_PROCESSING" || e.status === "BLOCKED_FAILED",
      ).length;

      console.log(`\nTotal manifests:       ${entries.length}`);
      console.log(`WOULD_IMPORT:          ${wouldImportCount}  (~${wouldImportRecords} records)`);
      console.log(`WILL_SKIP_DONE:        ${skipCount}`);
      if (blockCount > 0) {
        console.log(`BLOCKED (need action): ${blockCount}`);
        console.log(`\n⚠️  Blocked batches found. Run cleanup before importing:`);
        entries
          .filter((e) => e.status === "BLOCKED_PROCESSING" || e.status === "BLOCKED_FAILED")
          .forEach((e) => {
            console.log(
              `   npm run cleanup:import-batch -- --import-batch-id ${e.existingBatchId} --yes`,
            );
          });
      }
      console.log("---------------------\n");
      return;
    }

    // ---------------------------------------------------------------------------
    // Real run: abort if any blockers
    // ---------------------------------------------------------------------------
    if (hasBlockers) {
      console.error("\n❌ Cannot proceed: PROCESSING or FAILED batches exist.\n");
      entries
        .filter((e) => e.status === "BLOCKED_PROCESSING" || e.status === "BLOCKED_FAILED")
        .forEach((e) => {
          console.error(
            `   ${e.meta.xlsxFile}  status=${e.status}  batchId=${e.existingBatchId}`,
          );
          console.error(
            `   Run: npm run cleanup:import-batch -- --import-batch-id ${e.existingBatchId} --yes`,
          );
        });
      console.error(
        "\nAfter cleanup, re-run import. Use --dry-run first to confirm state.\n",
      );
      process.exit(1);
    }

    // ---------------------------------------------------------------------------
    // Summary + confirm
    // ---------------------------------------------------------------------------
    const toProcess = entries.filter((e) => e.status === "WOULD_IMPORT");
    const toSkip = entries.filter((e) => e.status === "WILL_SKIP_DONE");
    const wouldImportRecords = toProcess.reduce((sum, e) => sum + e.meta.recordCount, 0);

    console.log("\n--- Batch Import Plan ---");
    console.log(`Extract root:    ${extractRoot}`);
    console.log(`Workspace:       ${args.workspaceId}`);
    console.log(`User:            ${userId}`);
    console.log(`Scene:           ${args.scene ?? "(none)"}`);
    console.log(`Tags:            ${args.tags.length > 0 ? args.tags.join(", ") : "(none)"}`);
    console.log(`Files to import: ${toProcess.length}  (~${wouldImportRecords} records)`);
    console.log(`Files to skip:   ${toSkip.length}  (already DONE)`);
    console.log("-------------------------\n");

    if (toProcess.length === 0) {
      console.log("Nothing to import. All batches are already DONE.");
      return;
    }

    if (!args.yes) {
      const ok = await confirm("Proceed? (yes/no): ");
      if (!ok) {
        console.log("Aborted.");
        process.exit(0);
      }
    }

    // ---------------------------------------------------------------------------
    // Process manifests
    // ---------------------------------------------------------------------------
    let totalImported = 0;
    let totalSkippedDuplicate = 0;
    let totalSkippedNoImage = 0;
    let totalErrors = 0;
    let totalWarnings = 0;
    let totalPromptVersions = 0;
    let totalBytes = 0;

    await withConcurrency(toProcess, args.concurrencyFiles, async (entry) => {
      const imagesDir = path.join(entry.dir, "images");
      console.log(`\n>>> Processing: ${entry.meta.xlsxFile}`);

      const result = await importManifest(
        {
          manifestPath: entry.manifestPath,
          imagesDir,
          workspaceId: args.workspaceId,
          userId,
          sceneId,
          personId: entry.personId,
          tagIds,
          dryRun: false,
          limit: null,
          concurrency: args.concurrencyImages,
          batchLabel: entry.meta.xlsxFile,
        },
        prisma,
        supabase,
      );

      console.log(
        `<<< Done: ${entry.meta.xlsxFile}  imported=${result.imported}  skipped_dup=${result.skippedDuplicate}  errors=${result.errors}`,
      );

      totalImported += result.imported;
      totalSkippedDuplicate += result.skippedDuplicate;
      totalSkippedNoImage += result.skippedNoImage;
      totalErrors += result.errors;
      totalWarnings += result.warningCount;
      totalPromptVersions += result.promptVersionsCreated;
      totalBytes += result.totalUploadedBytes;
    });

    // ---------------------------------------------------------------------------
    // Total summary
    // ---------------------------------------------------------------------------
    console.log("\n=== Batch Import Total ===");
    console.log(`Files processed:       ${toProcess.length}`);
    console.log(`Files skipped:         ${toSkip.length}`);
    console.log(`Images imported:       ${totalImported}`);
    console.log(`Skipped (duplicate):   ${totalSkippedDuplicate}`);
    console.log(`Skipped (no image):    ${totalSkippedNoImage}`);
    console.log(`Errors:                ${totalErrors}`);
    console.log(`Warnings:              ${totalWarnings}`);
    console.log(`Prompt versions added: ${totalPromptVersions}`);
    console.log(`Total uploaded:        ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log("=========================\n");

    process.exit(totalErrors > 0 && totalImported === 0 ? 1 : 0);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
