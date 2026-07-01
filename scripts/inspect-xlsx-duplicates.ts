#!/usr/bin/env npx tsx
/**
 * inspect:xlsx-duplicates
 *
 * Check how many images in a manifest already exist in the DB (by fileHash),
 * and which importBatch they came from.
 *
 * Usage:
 *   npm run inspect:xlsx-duplicates -- \
 *     --workspace-id <id> \
 *     --manifest tmp/xlsx-extract/<folder>/manifest.json \
 *     --images-dir tmp/xlsx-extract/<folder>/images
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadEnv, createPrisma } from "./_lib/clients";

// ---- Args ------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
  };

  const workspaceId = get("--workspace-id");
  const manifestPath = get("--manifest");
  const imagesDir = get("--images-dir");

  if (!workspaceId || !manifestPath || !imagesDir) {
    console.error(`
Usage: npm run inspect:xlsx-duplicates -- \\
  --workspace-id <id> \\
  --manifest tmp/xlsx-extract/<folder>/manifest.json \\
  --images-dir tmp/xlsx-extract/<folder>/images
`);
    process.exit(1);
  }

  return { workspaceId, manifestPath, imagesDir };
}

// ---- Hash ------------------------------------------------------------------

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

// ---- Main ------------------------------------------------------------------

async function main() {
  const args = parseArgs();

  if (!fs.existsSync(args.manifestPath)) {
    console.error(`manifest not found: ${args.manifestPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(args.imagesDir)) {
    console.error(`images-dir not found: ${args.imagesDir}`);
    process.exit(1);
  }

  console.log(`\n🔍 XLSX Duplicate Inspector`);
  console.log(`   workspace-id: ${args.workspaceId}`);
  console.log(`   manifest:     ${args.manifestPath}`);
  console.log(`   images-dir:   ${args.imagesDir}\n`);

  // Load manifest
  JSON.parse(fs.readFileSync(args.manifestPath, "utf-8")); // validate JSON

  // Collect image files from images-dir
  const imageFiles = fs
    .readdirSync(args.imagesDir)
    .filter((f) => !f.startsWith(".") && !f.startsWith("~$"))
    .map((f) => path.join(args.imagesDir, f));

  console.log(`files: ${imageFiles.length}`);

  if (imageFiles.length === 0) {
    console.log(`\nNo image files found in images-dir.`);
    process.exit(0);
  }

  // Compute hashes
  process.stdout.write(`Computing SHA-256 hashes...`);
  const hashToFile = new Map<string, string>();
  for (const filePath of imageFiles) {
    const hash = sha256File(filePath);
    hashToFile.set(hash, path.basename(filePath));
  }
  console.log(` done (${hashToFile.size} unique hashes)\n`);

  // Query DB
  loadEnv();
  const prisma = createPrisma();

  try {
    const hashes = [...hashToFile.keys()];

    // Find matching images in DB
    const dbImages = await prisma.image.findMany({
      where: {
        workspaceId: args.workspaceId,
        fileHash: { in: hashes },
      },
      select: {
        fileHash: true,
        importBatchId: true,
      },
    });

    // Get batch file names for matched batches
    const batchIds = [...new Set(dbImages.map((i) => i.importBatchId).filter(Boolean))] as string[];
    const batches = batchIds.length > 0
      ? await prisma.importBatch.findMany({
          where: { id: { in: batchIds } },
          select: { id: true, fileName: true },
        })
      : [];
    const batchMap = new Map(batches.map((b) => [b.id, b.fileName]));

    const matchedHashes = new Set(dbImages.map((i) => i.fileHash).filter(Boolean) as string[]);

    const matchedCount = [...hashToFile.keys()].filter((h) => matchedHashes.has(h)).length;
    const unmatchedCount = hashToFile.size - matchedCount;

    console.log(`matched in DB: ${matchedCount}`);
    console.log(`unmatched:     ${unmatchedCount}`);

    // Group matches by importBatch fileName
    const matchesByFile = new Map<string, number>();
    for (const img of dbImages) {
      if (!img.fileHash || !matchedHashes.has(img.fileHash)) continue;
      const fileName = img.importBatchId ? (batchMap.get(img.importBatchId) ?? "(unknown batch)") : "(no batch)";
      matchesByFile.set(fileName, (matchesByFile.get(fileName) ?? 0) + 1);
    }

    if (matchesByFile.size > 0) {
      console.log(`\nMATCHED BY IMPORT FILE:`);
      for (const [fileName, count] of [...matchesByFile.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${fileName}: ${count}`);
      }
    }

    if (unmatchedCount > 0) {
      console.log(`\nUNMATCHED (not yet in DB): ${unmatchedCount}`);
      const unmatchedFiles = [...hashToFile.entries()]
        .filter(([h]) => !matchedHashes.has(h))
        .map(([, f]) => f);
      for (const f of unmatchedFiles.slice(0, 10)) {
        console.log(`  ${f}`);
      }
      if (unmatchedFiles.length > 10) {
        console.log(`  ... and ${unmatchedFiles.length - 10} more`);
      }
    }

    console.log(
      unmatchedCount === 0
        ? `\n✅ All images already imported — use --no-skip-existing to re-import.`
        : `\n📦 ${unmatchedCount} new image(s) ready to import.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
