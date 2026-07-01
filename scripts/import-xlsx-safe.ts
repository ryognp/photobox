#!/usr/bin/env npx tsx
/**
 * import:xlsx-safe
 *
 * All-in-one safe import pipeline:
 *   1. layout inspect
 *   2. extract --force
 *   3. manifest validate
 *   4. dry-run  (--dry-run stops here)
 *   5. user confirmation (skipped with --yes)
 *   6. import --yes --no-skip-existing
 *   7. storage audit
 *   8. summary report
 *
 * Usage:
 *   npm run import:xlsx-safe -- \
 *     --xlsx "/path/to/file.xlsx" \
 *     --workspace-id <id> \
 *     [--scene <name>] \
 *     [--tags <tag1,tag2>] \
 *     [--person-from-sheet-name] \
 *     [--dry-run]   stop after step 4 (dry-run only, no real import)
 *     [--yes]       skip interactive confirmation
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { makeSlug } from "./_lib/slug";

// ---- Args ------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
  };
  const has = (flag: string): boolean => args.includes(flag);

  const xlsx = get("--xlsx");
  const workspaceId = get("--workspace-id");

  if (!xlsx || !workspaceId) {
    console.error(`
Usage: npm run import:xlsx-safe -- \\
  --xlsx "/path/to/file.xlsx" \\
  --workspace-id <id> \\
  [--scene <name>] \\
  [--tags <tag1,tag2>] \\
  [--person-from-sheet-name] \\
  [--dry-run] \\
  [--yes]
`);
    process.exit(1);
  }

  return {
    xlsx,
    workspaceId,
    scene: get("--scene"),
    tags: get("--tags"),
    personFromSheetName: has("--person-from-sheet-name"),
    dryRun: has("--dry-run"),
    yes: has("--yes"),
  };
}

// ---- Helpers ---------------------------------------------------------------

/**
 * Run a tsx script via spawnSync with an explicit args array so that paths
 * containing spaces are never misinterpreted by a shell.
 */
function runScript(label: string, scriptPath: string, scriptArgs: string[]): void {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`▶  ${label}`);
  console.log(`   tsx ${scriptPath} ${scriptArgs.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`);
  console.log(`${"─".repeat(60)}`);

  const result = spawnSync("npx", ["tsx", scriptPath, ...scriptArgs], {
    stdio: "inherit",
    // Do NOT pass shell:true — that would re-introduce the quoting problem
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Script exited with status ${result.status ?? "null"}`);
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

// ---- Main ------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  const xlsxPath = path.resolve(args.xlsx);

  if (!fs.existsSync(xlsxPath)) {
    console.error(`XLSX not found: ${xlsxPath}`);
    process.exit(1);
  }

  const xlsxFileName = path.basename(xlsxPath);
  const xlsxDir = path.dirname(xlsxPath);
  const totalSteps = args.dryRun ? 4 : 7;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`🛡  import:xlsx-safe`);
  console.log(`   xlsx:                   ${xlsxPath}`);
  console.log(`   workspace-id:           ${args.workspaceId}`);
  console.log(`   scene:                  ${args.scene ?? "(none)"}`);
  console.log(`   tags:                   ${args.tags ?? "(none)"}`);
  console.log(`   person-from-sheet-name: ${args.personFromSheetName}`);
  console.log(`   dry-run:                ${args.dryRun}`);
  console.log(`   yes:                    ${args.yes}`);
  console.log(`${"═".repeat(60)}`);

  // ── Step 1: Layout inspect ─────────────────────────────────────────────────
  console.log(`\n[1/${totalSteps}] Layout inspect`);
  try {
    runScript("inspect:xlsx-layout", "scripts/inspect-xlsx-layout.ts", [xlsxPath]);
  } catch {
    console.error(`\n❌ Layout check FAILED. Fix the XLSX layout before importing.`);
    process.exit(1);
  }
  console.log(`\n✅ Layout OK`);

  // ── Step 2: Extract --force ────────────────────────────────────────────────
  console.log(`\n[2/${totalSteps}] Extract`);
  runScript("extract:xlsx-batch --force", "scripts/extract-xlsx-batch.ts", [
    "--xlsx-dir", xlsxDir,
    "--out-root", "tmp/xlsx-extract",
    "--only", xlsxFileName,
    "--force",
    "--stop-on-error",
  ]);

  // ── Step 3: Manifest validate ──────────────────────────────────────────────
  console.log(`\n[3/${totalSteps}] Manifest validate`);

  const extractFolder = path.resolve("tmp/xlsx-extract", makeSlug(xlsxFileName));
  const manifestPath = path.join(extractFolder, "manifest.json");

  if (!fs.existsSync(manifestPath)) {
    console.error(`\n❌ manifest.json not found at: ${manifestPath}`);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
    xlsxFile: string;
    sheetName: string;
    mediaFileCount: number;
    anchorCount: number;
    recordCount: number;
    readyCount: number;
  };

  console.log(`   xlsxFile:       ${manifest.xlsxFile}`);
  console.log(`   sheetName:      ${manifest.sheetName}`);
  console.log(`   mediaFileCount: ${manifest.mediaFileCount}`);
  console.log(`   anchorCount:    ${manifest.anchorCount}`);
  console.log(`   recordCount:    ${manifest.recordCount}`);
  console.log(`   readyCount:     ${manifest.readyCount}`);

  if (manifest.recordCount === 0) {
    console.error(`\n❌ ERROR: recordCount=0 in manifest.`);
    if (manifest.mediaFileCount > 0 && manifest.anchorCount > 0) {
      console.error(`   Images were found but no records were normalized.`);
      console.error(`   Possible causes:`);
      console.error(`   - Images are not anchored in column A`);
      console.error(`   - Prompts are not in columns B/C`);
    }
    console.error(`   Fix the XLSX and re-run.`);
    process.exit(1);
  }

  if (manifest.readyCount === 0) {
    console.error(`\n❌ ERROR: readyCount=0 in manifest.`);
    process.exit(1);
  }

  console.log(`\n✅ Manifest valid (${manifest.readyCount} ready records)`);

  // ── Step 4: Dry-run ────────────────────────────────────────────────────────
  console.log(`\n[4/${totalSteps}] Dry-run import`);

  // Base args shared by dry-run and real import
  const importArgs: string[] = [
    "--workspace-id", args.workspaceId,
    "--extract-root", "tmp/xlsx-extract",
    "--only", xlsxFileName,
    "--no-skip-existing",
  ];
  if (args.personFromSheetName) importArgs.push("--person-from-sheet-name");
  if (args.scene) importArgs.push("--scene", args.scene);
  if (args.tags) importArgs.push("--tags", args.tags);

  runScript("import:xlsx-batch --dry-run", "scripts/import-xlsx-batch.ts", [
    ...importArgs,
    "--dry-run",
  ]);

  // Stop here if --dry-run was requested
  if (args.dryRun) {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`🧪 --dry-run: stopping after step 4.`);
    console.log(`   Remove --dry-run to proceed with real import.`);
    console.log(`${"═".repeat(60)}\n`);
    return;
  }

  // ── Step 5: User confirmation ──────────────────────────────────────────────
  console.log(`\n[5/${totalSteps}] Confirmation`);
  if (!args.yes) {
    const ok = await confirm(`Proceed with real import of "${xlsxFileName}"?`);
    if (!ok) {
      console.log(`\nAborted.`);
      process.exit(0);
    }
  } else {
    console.log(`   --yes flag set, skipping interactive confirmation.`);
  }

  // ── Step 6: Real import ────────────────────────────────────────────────────
  console.log(`\n[6/${totalSteps}] Import`);
  runScript("import:xlsx-batch --yes --no-skip-existing", "scripts/import-xlsx-batch.ts", [
    ...importArgs,
    "--yes",
    "--concurrency-files", "1",
    "--concurrency-images", "3",
  ]);

  // ── Step 7: Storage audit ──────────────────────────────────────────────────
  console.log(`\n[7/${totalSteps}] Storage audit`);
  runScript("audit:storage-assets", "scripts/audit-storage-assets.ts", [
    "--workspace-id", args.workspaceId,
  ]);

  // ── Step 8: Summary ────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(60)}`);
  console.log(`✅ import:xlsx-safe completed`);
  console.log(`   XLSX:    ${xlsxFileName}`);
  console.log(`   records: ${manifest.readyCount}`);
  console.log(`${"═".repeat(60)}\n`);
}

main().catch((e) => {
  console.error("\nFatal error:", e.message ?? e);
  process.exit(1);
});
