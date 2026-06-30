#!/usr/bin/env npx tsx
/**
 * XLSX Batch Extractor
 *
 * Usage:
 *   npm run extract:xlsx-batch -- --xlsx-dir /path/to/dir [options]
 *
 * Options:
 *   --xlsx-dir <dir>        Required. Directory containing .xlsx files.
 *   --out-root <dir>        Default: tmp/xlsx-extract
 *   --dry-run               List files + planned output, no actual extraction.
 *   --force                 Overwrite existing outputs.
 *   --skip-existing         (default true) Skip files with existing manifest.json.
 *   --no-skip-existing      Always re-extract (same as --force per file).
 *   --limit-files <N>       Process only first N files.
 *   --only <filename>       Process only this specific filename (can repeat).
 *   --stop-on-error         Abort on first error (default: continue).
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { extractXlsx, defaultOutDir } from "./extract-xlsx-images";

// ---- Args -----------------------------------------------------------------

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "xlsx-dir": { type: "string" },
    "out-root": { type: "string", default: "tmp/xlsx-extract" },
    "dry-run": { type: "boolean", default: false },
    "force": { type: "boolean", default: false },
    "skip-existing": { type: "boolean", default: true },
    "no-skip-existing": { type: "boolean", default: false },
    "limit-files": { type: "string" },
    "only": { type: "string" },
    "stop-on-error": { type: "boolean", default: false },
  },
  strict: false,
});

const xlsxDir = values["xlsx-dir"] as string | undefined;
const outRoot = path.resolve(process.cwd(), (values["out-root"] as string | undefined) ?? "tmp/xlsx-extract");
const dryRun = (values["dry-run"] as boolean | undefined) ?? false;
const force = (values["force"] as boolean | undefined) ?? false;
const skipExistingFlag = (values["skip-existing"] as boolean | undefined) ?? true;
const noSkipExisting = (values["no-skip-existing"] as boolean | undefined) ?? false;
const skipExisting = !noSkipExisting && skipExistingFlag;
const limitFiles = values["limit-files"] ? parseInt(values["limit-files"] as string, 10) : null;
const onlyFiles = values["only"] ? [values["only"] as string].flat() : [];
const stopOnError = (values["stop-on-error"] as boolean | undefined) ?? false;

// ---- Validate -------------------------------------------------------------

if (!xlsxDir) {
  console.error(`
Usage: npm run extract:xlsx-batch -- --xlsx-dir /path/to/dir [options]

Options:
  --xlsx-dir <dir>       Required
  --out-root <dir>       Default: tmp/xlsx-extract
  --dry-run
  --force
  --skip-existing        (default true)
  --no-skip-existing
  --limit-files <N>
  --only <filename>
  --stop-on-error
`);
  process.exit(1);
}

if (!fs.existsSync(xlsxDir)) {
  console.error(`xlsx-dir not found: ${xlsxDir}`);
  process.exit(1);
}

// After validation, xlsxDir is guaranteed to be a string
const xlsxDirPath: string = xlsxDir;

// ---- Discover XLSX files --------------------------------------------------

let files = fs
  .readdirSync(xlsxDirPath)
  .filter((f) => f.toLowerCase().endsWith(".xlsx") && !f.startsWith("~$") && !f.startsWith("._"))
  .sort();

if (onlyFiles.length > 0) {
  const pattern = onlyFiles[0].toLowerCase();
  const matched = files.filter((f) => f.toLowerCase().includes(pattern));
  if (matched.length === 0) {
    console.error(`\n❌ --only "${onlyFiles[0]}" matched no XLSX files.`);
    console.error(`   Available files:`);
    files.forEach((f) => console.error(`     ${f}`));
    process.exit(1);
  }
  if (matched.length > 1) {
    console.error(`\n❌ --only "${onlyFiles[0]}" matched multiple files. Please be more specific:`);
    matched.forEach((f) => console.error(`     ${f}`));
    process.exit(1);
  }
  console.log(`\n🎯 --only: matched "${matched[0]}"`);
  files = matched;
}
if (limitFiles !== null) {
  files = files.slice(0, limitFiles);
}

console.log(`\n📂 XLSX Batch Extractor`);
console.log(`   xlsx-dir:      ${xlsxDirPath}`);
console.log(`   out-root:      ${outRoot}`);
console.log(`   files found:   ${files.length} (after filter/limit)`);
console.log(`   dry-run:       ${dryRun}`);
console.log(`   force:         ${force}`);
console.log(`   skip-existing: ${skipExisting}`);
console.log(`   stop-on-error: ${stopOnError}`);

// ---- Types ----------------------------------------------------------------

type FileStatus = "pending" | "skip_existing" | "would_extract" | "extracted" | "error" | "skipped_error";

interface FilePlan {
  fileName: string;
  xlsxPath: string;
  outDir: string;
  sizeMb: number;
  hasExisting: boolean;
  status: FileStatus;
  recordCount?: number;
  errorMessage?: string;
}

// ---- Main -----------------------------------------------------------------

async function main() {

const plans: FilePlan[] = files.map((f) => {
  const xlsxPath = path.join(xlsxDirPath, f);
  const outDir = defaultOutDir(xlsxPath, path.relative(process.cwd(), outRoot));
  const hasExisting = fs.existsSync(path.join(outDir, "manifest.json"));
  const sizeMb = fs.statSync(xlsxPath).size / 1024 / 1024;
  const wouldSkip = skipExisting && hasExisting && !force;
  return {
    fileName: f,
    xlsxPath,
    outDir,
    sizeMb,
    hasExisting,
    status: wouldSkip ? "skip_existing" : "pending",
  };
});

console.log(`\n📋 File plan:`);
for (const p of plans) {
  const existing = p.hasExisting ? "✅ has manifest" : "⬜ no manifest";
  const action = p.status === "skip_existing" ? "SKIP (existing)" : "EXTRACT";
  console.log(`  ${action}  ${p.fileName}  (${p.sizeMb.toFixed(1)} MB)  ${existing}`);
  console.log(`         → ${p.outDir}`);
}

const toExtract = plans.filter((p) => p.status === "pending");
const toSkip = plans.filter((p) => p.status === "skip_existing");
console.log(`\n   to extract: ${toExtract.length}`);
console.log(`   to skip:    ${toSkip.length}`);

if (dryRun) {
  console.log(`\n🧪 DRY RUN — no extraction performed.`);
  process.exit(0);
}

if (toExtract.length === 0) {
  console.log(`\nNothing to do. Use --force or --no-skip-existing to re-extract.`);
  process.exit(0);
}

// ---- Extract sequentially ------------------------------------------------

console.log(`\n🚀 Starting extraction (${toExtract.length} files)...\n`);

let successCount = 0;
let errorCount = 0;

for (const plan of plans) {
  if (plan.status === "skip_existing") {
    console.log(`⏭️  [SKIP] ${plan.fileName} (existing manifest)`);
    continue;
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`📦 Extracting: ${plan.fileName} (${plan.sizeMb.toFixed(1)} MB)`);
  console.log(`${"─".repeat(60)}`);

  try {
    const summary = await extractXlsx(plan.xlsxPath, plan.outDir, force);
    plan.status = "extracted";
    plan.recordCount = summary.recordCount;
    successCount++;
    console.log(`\n✅ Done: ${plan.fileName} → ${summary.recordCount} records`);
  } catch (err) {
    plan.status = "error";
    plan.errorMessage = err instanceof Error ? err.message : String(err);
    errorCount++;
    console.error(`\n❌ Error: ${plan.fileName}\n   ${plan.errorMessage}`);
    if (stopOnError) {
      console.error("Stopping due to --stop-on-error.");
      break;
    }
    plan.status = "skipped_error";
  }
}

// ---- Final summary -------------------------------------------------------

console.log(`\n${"═".repeat(60)}`);
console.log(`📊 Batch Extract Summary`);
console.log(`${"═".repeat(60)}`);
console.log(`   total files:  ${plans.length}`);
console.log(`   extracted:    ${successCount}`);
console.log(`   skipped:      ${toSkip.length}`);
console.log(`   errors:       ${errorCount}`);

if (errorCount > 0) {
  console.log(`\n❌ Errors:`);
  for (const p of plans.filter((p) => p.status === "error" || p.status === "skipped_error")) {
    console.log(`   ${p.fileName}: ${p.errorMessage}`);
  }
}

console.log(`\n📂 Output root: ${outRoot}`);
for (const p of plans.filter((p) => p.status === "extracted")) {
  console.log(`   ${p.fileName} → ${path.basename(p.outDir)}/ (${p.recordCount ?? "?"} records)`);
}

console.log(`\n✅ Batch extraction complete.`);

} // end main

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
