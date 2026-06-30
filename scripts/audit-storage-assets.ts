/**
 * audit-storage-assets.ts
 *
 * Compares Storage bucket contents against DB image records for a workspace.
 * Reports missing files (DB has path but Storage doesn't) and orphan files
 * (Storage has file but no DB record references it).
 *
 * Usage:
 *   npm run audit:storage-assets -- --workspace-id <id> [--dry-run]
 *   npm run audit:storage-assets -- --workspace-id <id> --cleanup-orphans [--yes]
 */

import readline from "node:readline";
import { loadEnv, createSupabaseAdmin, createPrisma } from "./_lib/clients";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  workspaceId: string | null;
  dryRun: boolean;
  cleanupOrphans: boolean;
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
    dryRun: has("--dry-run") || !has("--cleanup-orphans"),
    cleanupOrphans: has("--cleanup-orphans"),
    yes: has("--yes"),
  };
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(prompt, resolve));
  rl.close();
  return answer.trim().toLowerCase() === "yes";
}

// ---------------------------------------------------------------------------
// List all files under a prefix in Supabase Storage (paginated)
// ---------------------------------------------------------------------------

async function listAllStorageFiles(
  supabase: ReturnType<typeof createSupabaseAdmin>,
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const allPaths: string[] = [];
  const PAGE_SIZE = 1000;
  let offset = 0;

  while (true) {
    const { data, error } = await supabase.storage.from(bucket).list(prefix, {
      limit: PAGE_SIZE,
      offset,
      sortBy: { column: "name", order: "asc" },
    });

    if (error) {
      throw new Error(`Storage list error at prefix="${prefix}": ${error.message}`);
    }
    if (!data || data.length === 0) break;

    for (const item of data) {
      if (item.id === null) {
        // This is a "folder" — recurse into it
        const subPrefix = prefix ? `${prefix}/${item.name}` : item.name;
        const subFiles = await listAllStorageFiles(supabase, bucket, subPrefix);
        allPaths.push(...subFiles);
      } else {
        // This is a file
        const filePath = prefix ? `${prefix}/${item.name}` : item.name;
        allPaths.push(filePath);
      }
    }

    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return allPaths;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnv();

  const args = parseArgs(process.argv);

  if (!args.workspaceId) {
    console.error(`
Usage: npm run audit:storage-assets -- \\
  --workspace-id <id>     Required
  [--dry-run]             List only (default when --cleanup-orphans is omitted)
  [--cleanup-orphans]     Enable orphan deletion mode
  [--yes]                 Skip confirmation for cleanup
`);
    process.exit(1);
  }

  const workspaceId: string = args.workspaceId;
  const BUCKET = "photobox-private";
  const ASSET_PREFIX = `${workspaceId}/assets`;

  const prisma = createPrisma();
  const supabase = createSupabaseAdmin();

  try {
    console.log(`\nWorkspace: ${workspaceId}`);
    console.log(`Bucket:    ${BUCKET}`);
    console.log(`Prefix:    ${ASSET_PREFIX}/`);
    console.log(`Mode:      ${args.cleanupOrphans ? "CLEANUP ORPHANS" : "AUDIT ONLY"}\n`);

    // -----------------------------------------------------------------------
    // Step 1: Collect DB paths
    // -----------------------------------------------------------------------
    console.log("Loading DB image records...");
    const images = await prisma.image.findMany({
      where: { workspaceId, deletedAt: null },
      select: { id: true, storagePath: true, thumbnailPath: true, previewPath: true },
    });

    const dbPaths = new Set<string>();
    for (const img of images) {
      dbPaths.add(img.storagePath);
      if (img.thumbnailPath) dbPaths.add(img.thumbnailPath);
      if (img.previewPath) dbPaths.add(img.previewPath);
    }

    console.log(`DB images: ${images.length} records → ${dbPaths.size} unique paths`);

    // -----------------------------------------------------------------------
    // Step 2: Collect Storage paths
    // -----------------------------------------------------------------------
    console.log("Listing Storage files (this may take a moment)...");
    const storagePaths = await listAllStorageFiles(supabase, BUCKET, ASSET_PREFIX);
    const storageSet = new Set(storagePaths);

    console.log(`Storage files: ${storagePaths.length} under ${ASSET_PREFIX}/\n`);

    // -----------------------------------------------------------------------
    // Step 3: Cross-reference
    // -----------------------------------------------------------------------
    const missingFiles: string[] = [];   // in DB but not in Storage
    const orphanFiles: string[] = [];    // in Storage but not referenced by DB

    for (const dbPath of dbPaths) {
      if (!storageSet.has(dbPath)) {
        missingFiles.push(dbPath);
      }
    }

    for (const storagePath of storagePaths) {
      if (!dbPaths.has(storagePath)) {
        orphanFiles.push(storagePath);
      }
    }

    // Categorize by variant type
    const origCount    = storagePaths.filter((p) => p.includes("/original.")).length;
    const thumbCount   = storagePaths.filter((p) => p.includes("/thumbnail.")).length;
    const previewCount = storagePaths.filter((p) => p.includes("/preview.")).length;

    // -----------------------------------------------------------------------
    // Step 4: Report
    // -----------------------------------------------------------------------
    console.log("=== Storage Audit Report ===");
    console.log(`DB image records:     ${images.length}`);
    console.log(`DB paths total:       ${dbPaths.size}`);
    console.log(`Storage files total:  ${storagePaths.length}`);
    console.log(`  originals:          ${origCount}`);
    console.log(`  thumbnails:         ${thumbCount}`);
    console.log(`  previews:           ${previewCount}`);
    console.log("");
    console.log(`Missing files (DB→Storage): ${missingFiles.length}`);
    if (missingFiles.length > 0) {
      missingFiles.forEach((p) => console.log(`  MISSING  ${p}`));
    }
    console.log(`Orphan files (Storage→DB):  ${orphanFiles.length}`);
    if (orphanFiles.length > 0) {
      orphanFiles.forEach((p) => console.log(`  ORPHAN   ${p}`));
    }
    console.log("============================\n");

    if (orphanFiles.length === 0) {
      console.log("✅ No orphan files found. Storage is clean.");
    }
    if (missingFiles.length === 0) {
      console.log("✅ No missing files. All DB paths exist in Storage.");
    }

    // -----------------------------------------------------------------------
    // Step 5: Cleanup orphans (if requested)
    // -----------------------------------------------------------------------
    if (!args.cleanupOrphans || orphanFiles.length === 0) {
      if (args.cleanupOrphans && orphanFiles.length === 0) {
        console.log("Nothing to clean up.");
      }
      return;
    }

    if (!args.yes) {
      const ok = await confirm(
        `\nDelete ${orphanFiles.length} orphan file(s) from Storage? (yes/no): `,
      );
      if (!ok) {
        console.log("Aborted.");
        return;
      }
    }

    console.log(`\nDeleting ${orphanFiles.length} orphan file(s)...`);
    const CHUNK_SIZE = 100;
    let deletedOk = 0;
    let deletedFail = 0;

    for (let i = 0; i < orphanFiles.length; i += CHUNK_SIZE) {
      const chunk = orphanFiles.slice(i, i + CHUNK_SIZE);
      const { error } = await supabase.storage.from(BUCKET).remove(chunk);
      if (error) {
        console.warn(`  Chunk ${Math.floor(i / CHUNK_SIZE) + 1} error: ${error.message}`);
        deletedFail += chunk.length;
      } else {
        deletedOk += chunk.length;
      }
    }

    console.log(`\nOrphan cleanup complete:`);
    console.log(`  Deleted: ${deletedOk}`);
    if (deletedFail > 0) console.log(`  Failed:  ${deletedFail}`);

  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
