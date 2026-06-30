/**
 * import-xlsx-extract.ts
 *
 * Full-featured single-manifest XLSX import CLI.
 *
 * Usage:
 *   npm run import:xlsx-extract -- \
 *     --manifest <path> \
 *     --workspace-id <id> \
 *     [--images-dir <path>] \
 *     [--user-id <id>] \
 *     [--person <name>] \
 *     [--person-from-sheet-name] \
 *     [--person-from-file-name] \
 *     [--scene <name>] \
 *     [--tags <tag1,tag2>] \
 *     [--dry-run] \
 *     [--limit <N>] \
 *     [--yes] \
 *     [--concurrency <N>]
 */

import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { loadEnv, createSupabaseAdmin, createPrisma } from "./_lib/clients";
import { importManifest } from "./_lib/importManifest";
import { makeSlug } from "./_lib/slug";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  manifest: string;
  workspaceId: string;
  imagesDir: string | null;
  userId: string | null;
  person: string | null;
  personFromSheetName: boolean;
  personFromFileName: boolean;
  scene: string | null;
  tags: string[];
  dryRun: boolean;
  limit: number | null;
  yes: boolean;
  concurrency: number;
}

function printUsage(): void {
  console.error(`
Usage: npx tsx scripts/import-xlsx-extract.ts \\
  --manifest <path>           Path to manifest.json (required)
  --workspace-id <id>         Workspace ID (required)
  [--images-dir <path>]       Images directory (default: {manifestDir}/images)
  [--user-id <id>]            User ID (if omitted, looks up workspace owner)
  [--person <name>]           Explicit person name
  [--person-from-sheet-name]  Use manifest.sheetName as person name
  [--person-from-file-name]   Use manifest.xlsxFile basename as person name
  [--scene <name>]            Upsert scene by name
  [--tags <tag1,tag2>]        Comma-separated tag names
  [--dry-run]                 No DB/Storage writes
  [--limit <N>]               Process only first N eligible records
  [--yes]                     Skip interactive confirmation
  [--concurrency <N>]         Image-level concurrency (default 3, max 8)
`);
}

function parseArgs(argv: string[]): CliArgs | null {
  const args = argv.slice(2);
  const get = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
  };
  const has = (flag: string): boolean => args.includes(flag);

  const manifest = get("--manifest");
  const workspaceId = get("--workspace-id");

  if (!manifest || !workspaceId) {
    return null;
  }

  const concurrencyRaw = parseInt(get("--concurrency") ?? "3", 10);
  const concurrency = Math.min(Math.max(isNaN(concurrencyRaw) ? 3 : concurrencyRaw, 1), 8);

  const limitRaw = get("--limit");
  const limit = limitRaw !== null ? parseInt(limitRaw, 10) : null;

  const tagsRaw = get("--tags");
  const tags = tagsRaw ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean) : [];

  return {
    manifest,
    workspaceId,
    imagesDir: get("--images-dir"),
    userId: get("--user-id"),
    person: get("--person"),
    personFromSheetName: has("--person-from-sheet-name"),
    personFromFileName: has("--person-from-file-name"),
    scene: get("--scene"),
    tags,
    dryRun: has("--dry-run"),
    limit: limit !== null && !isNaN(limit) ? limit : null,
    yes: has("--yes"),
    concurrency,
  };
}

// ---------------------------------------------------------------------------
// Manifest type (minimal, for pre-import resolution)
// ---------------------------------------------------------------------------

interface ManifestMeta {
  xlsxFile: string;
  sheetName: string;
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
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnv();

  const args = parseArgs(process.argv);
  if (!args) {
    printUsage();
    process.exit(1);
  }

  // Resolve manifest path
  const manifestPath = path.resolve(args.manifest);
  try {
    await fs.access(manifestPath);
  } catch {
    console.error(`Error: manifest file not found: ${manifestPath}`);
    process.exit(1);
  }

  // Read manifest metadata
  const manifestRaw = await fs.readFile(manifestPath, "utf-8");
  const manifestMeta: ManifestMeta = JSON.parse(manifestRaw) as ManifestMeta;

  // Resolve images dir
  const manifestDir = path.dirname(manifestPath);
  const imagesDir = args.imagesDir ? path.resolve(args.imagesDir) : path.join(manifestDir, "images");

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
    // Resolve person name → personId
    // ---------------------------------------------------------------------------
    let personName: string | null = null;
    if (args.person) {
      personName = args.person;
    } else if (args.personFromSheetName) {
      personName = manifestMeta.sheetName;
    } else if (args.personFromFileName) {
      personName = makeSlug(manifestMeta.xlsxFile);
    }

    let personId: string | null = null;
    if (personName && !args.dryRun) {
      const person = await prisma.person.upsert({
        where: { workspaceId_name: { workspaceId: args.workspaceId, name: personName } },
        create: { workspaceId: args.workspaceId, name: personName },
        update: {},
      });
      personId = person.id;
      console.log(`Person upserted: "${personName}" (${personId})`);
    } else if (personName && args.dryRun) {
      console.log(`[DRY RUN] Would upsert person: "${personName}"`);
    }

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
    } else if (args.scene && args.dryRun) {
      console.log(`[DRY RUN] Would upsert scene: "${args.scene}"`);
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
    } else if (args.tags.length > 0 && args.dryRun) {
      console.log(`[DRY RUN] Would upsert tags: ${args.tags.join(", ")}`);
    }

    // ---------------------------------------------------------------------------
    // Print summary & confirm
    // ---------------------------------------------------------------------------
    console.log("\n--- Import Summary ---");
    console.log(`Manifest:    ${manifestPath}`);
    console.log(`Images dir:  ${imagesDir}`);
    console.log(`Workspace:   ${args.workspaceId}`);
    console.log(`User:        ${userId}`);
    console.log(`Person:      ${personName ?? "(none)"}`);
    console.log(`Scene:       ${args.scene ?? "(none)"}`);
    console.log(`Tags:        ${args.tags.length > 0 ? args.tags.join(", ") : "(none)"}`);
    console.log(`Dry run:     ${args.dryRun}`);
    console.log(`Limit:       ${args.limit ?? "none"}`);
    console.log(`Concurrency: ${args.concurrency}`);
    console.log("---------------------\n");

    if (!args.dryRun && !args.yes) {
      const ok = await confirm("Proceed? (yes/no): ");
      if (!ok) {
        console.log("Aborted.");
        process.exit(0);
      }
    }

    // ---------------------------------------------------------------------------
    // Run import
    // ---------------------------------------------------------------------------
    const result = await importManifest(
      {
        manifestPath,
        imagesDir,
        workspaceId: args.workspaceId,
        userId,
        sceneId,
        personId,
        tagIds,
        dryRun: args.dryRun,
        limit: args.limit,
        concurrency: args.concurrency,
      },
      prisma,
      supabase,
    );

    // ---------------------------------------------------------------------------
    // Print detailed result
    // ---------------------------------------------------------------------------
    console.log("\n=== Import Result ===");
    console.log(`Batch ID:              ${result.batchId ?? "(dry run)"}`);
    console.log(`Imported:              ${result.imported}`);
    console.log(`Skipped (duplicate):   ${result.skippedDuplicate}`);
    console.log(`Skipped (no image):    ${result.skippedNoImage}`);
    console.log(`Errors:                ${result.errors}`);
    console.log(`Warnings:              ${result.warningCount}`);
    console.log(`Prompt versions added: ${result.promptVersionsCreated}`);
    console.log(
      `Total uploaded:        ${(result.totalUploadedBytes / 1024 / 1024).toFixed(2)} MB`,
    );

    if (result.importedImages.length > 0) {
      console.log("\nFirst imported images:");
      result.importedImages.slice(0, 5).forEach((img) => {
        console.log(`  row ${img.row}: ${img.imageId}  ${img.outputFileName}`);
      });
    }

    if (result.errorDetails.length > 0) {
      console.log("\nFirst errors:");
      result.errorDetails.slice(0, 5).forEach((e) => {
        console.log(`  row ${e.row}: ${e.reason}`);
      });
    }

    console.log("====================\n");

    process.exit(result.errors > 0 && result.imported === 0 ? 1 : 0);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
