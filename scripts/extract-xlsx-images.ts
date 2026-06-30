#!/usr/bin/env npx tsx
/**
 * XLSX Embedded Image Extractor
 *
 * Single-file usage:
 *   npm run extract:xlsx-images -- /path/to/file.xlsx [--out-dir dir] [--force]
 *
 * Importable function:
 *   import { extractXlsx } from "./extract-xlsx-images"
 *
 * Output per XLSX:
 *   {outDir}/manifest.json   full-text prompts + all metadata
 *   {outDir}/manifest.csv    preview-only
 *   {outDir}/images/         row_N_col_A_imageXX.png  (renamed only)
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";
import { makeSlug } from "./_lib/slug";

// ---- Column config (sheet layout: A=image, B=EN prompt, C=JA prompt) ------

const DATA_START_ROW = 2;
const IMG_COL0 = 0;
const EN_COL0 = 1;
const JA_COL0 = 2;

// ---- Types ----------------------------------------------------------------

type RecordStatus = "ready" | "missing_image" | "missing_prompt" | "error";
type RecordFlag =
  | "missing_en_prompt"
  | "missing_ja_prompt"
  | "missing_image"
  | "duplicate_target"
  | "empty_prompt_en"
  | "empty_prompt_ja";

interface AnchorInfo {
  row0: number;
  col0: number;
  rId: string;
}

export interface NormalizedRecord {
  index: number;
  sheetName: string;
  row0: number;
  rowNumber: number;
  imageCol0: number;
  imageColumn: string;
  promptEnCol0: number;
  promptJaCol0: number;
  imageTarget: string;
  imageFileName: string;
  imageSizeBytes: number;
  outputFileName: string;
  outputRelativePath: string;
  hasImage: boolean;
  hasPromptEn: boolean;
  hasPromptJa: boolean;
  status: RecordStatus;
  flags: RecordFlag[];
  isDuplicateTarget: boolean;
  duplicateGroupKey: string | null;
  duplicateTargetCount: number;
  promptEn: string;
  promptJa: string;
  promptEnPreview: string;
  promptJaPreview: string;
}

export interface ExtractSummary {
  outDir: string;
  xlsxFile: string;
  sheetName: string;
  mediaFileCount: number;
  anchorCount: number;
  recordCount: number;
  readyCount: number;
  missingImageCount: number;
  missingEnCount: number;
  missingJaCount: number;
  duplicateTargetRecordCount: number;
  uniqueDuplicateTargetCount: number;
  outputImageCount: number;
  records: NormalizedRecord[];
}

// ---- XML parser -----------------------------------------------------------

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  transformTagName: (tag: string) => tag.replace(/^[^:]+:/, ""),
  isArray: (tagName) =>
    ["Relationship", "oneCellAnchor", "twoCellAnchor", "row", "c", "si"].includes(tagName),
});

// ---- Helpers --------------------------------------------------------------

function colIndexToLetter(index: number): string {
  let result = "";
  let n = index;
  do {
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return result;
}

function parseCellRef(ref: string): { col0: number; row1: number } {
  const m = ref.match(/^([A-Z]+)(\d+)$/);
  if (!m) throw new Error(`Invalid cell ref: ${ref}`);
  const col0 = m[1].split("").reduce((acc, ch) => acc * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return { col0, row1: parseInt(m[2], 10) };
}

function previewText(text: string, max = 60): string {
  if (!text) return "";
  return text.length <= max ? text : text.slice(0, max) + "…";
}

// ---- XML parsers ----------------------------------------------------------

function parseDrawing(xml: string): AnchorInfo[] {
  const doc = xmlParser.parse(xml) as Record<string, unknown>;
  const root = (doc["wsDr"] ?? doc[Object.keys(doc)[0]]) as Record<string, unknown>;
  if (!root) return [];
  const anchors: AnchorInfo[] = [];
  const processAnchor = (anchor: unknown) => {
    const a = anchor as Record<string, unknown>;
    const from = a["from"] as Record<string, unknown> | undefined;
    if (!from) return;
    const row0 = parseInt(String(from["row"] ?? "0"), 10);
    const col0 = parseInt(String(from["col"] ?? "0"), 10);
    const pic = a["pic"] as Record<string, unknown> | undefined;
    const blipFill = pic?.["blipFill"] as Record<string, unknown> | undefined;
    const blip = blipFill?.["blip"] as Record<string, unknown> | undefined;
    const rId =
      (blip?.["@_r:embed"] as string | undefined) ??
      (blip?.["@_embed"] as string | undefined) ??
      "";
    if (rId) anchors.push({ row0, col0, rId });
  };
  const oneCells = root["oneCellAnchor"];
  const twoCells = root["twoCellAnchor"];
  if (Array.isArray(oneCells)) oneCells.forEach(processAnchor);
  else if (oneCells) processAnchor(oneCells);
  if (Array.isArray(twoCells)) twoCells.forEach(processAnchor);
  else if (twoCells) processAnchor(twoCells);
  return anchors;
}

function parseDrawingRels(xml: string): Map<string, string> {
  const doc = xmlParser.parse(xml) as Record<string, unknown>;
  const relationships = doc["Relationships"] as Record<string, unknown> | undefined;
  const rels = (relationships?.["Relationship"] ?? []) as unknown[];
  const map = new Map<string, string>();
  for (const rel of rels) {
    const r = rel as Record<string, unknown>;
    const id = r["@_Id"] as string | undefined;
    const target = r["@_Target"] as string | undefined;
    if (id && target) map.set(id, target);
  }
  return map;
}

function parseSharedStrings(xml: string): string[] {
  const doc = xmlParser.parse(xml) as Record<string, unknown>;
  const sst = doc["sst"] as Record<string, unknown> | undefined;
  if (!sst) return [];
  const siList = (sst["si"] ?? []) as unknown[];
  return siList.map((si) => {
    const s = si as Record<string, unknown>;
    const t = s["t"];
    if (typeof t === "string") return t;
    if (typeof t === "number") return String(t);
    if (t && typeof t === "object") {
      const tObj = t as Record<string, unknown>;
      return String(tObj["#text"] ?? tObj["_text"] ?? "");
    }
    const rArr = s["r"];
    if (Array.isArray(rArr)) {
      return rArr.map((r) => {
        const ro = r as Record<string, unknown>;
        const rt = ro["t"];
        if (typeof rt === "string") return rt;
        if (rt && typeof rt === "object") return String((rt as Record<string, unknown>)["#text"] ?? "");
        return "";
      }).join("");
    }
    return "";
  });
}

function parseSheetCells(xml: string, sharedStrings: string[]): Map<string, string> {
  const doc = xmlParser.parse(xml) as Record<string, unknown>;
  const ws = doc["worksheet"] as Record<string, unknown> | undefined;
  const sheetData = ws?.["sheetData"] as Record<string, unknown> | undefined;
  const cellMap = new Map<string, string>();
  if (!sheetData) return cellMap;
  const rows = (sheetData["row"] ?? []) as unknown[];
  for (const rowEl of rows) {
    const r = rowEl as Record<string, unknown>;
    const rowNum = parseInt(String(r["@_r"] ?? "0"), 10);
    const cells = (r["c"] ?? []) as unknown[];
    for (const cellEl of cells) {
      const c = cellEl as Record<string, unknown>;
      const ref = c["@_r"] as string | undefined;
      if (!ref) continue;
      const { col0 } = parseCellRef(ref);
      const cellType = c["@_t"] as string | undefined;
      const v = c["v"];
      const is = c["is"] as Record<string, unknown> | undefined;
      let value = "";
      if (cellType === "s" && v !== undefined) {
        value = sharedStrings[parseInt(String(v), 10)] ?? "";
      } else if (cellType === "inlineStr" && is) {
        const t = is["t"];
        value = typeof t === "string" ? t : String((t as Record<string, unknown>)?.["#text"] ?? "");
      } else if (v !== undefined && v !== null) {
        value = String(v);
      }
      cellMap.set(`${rowNum}:${col0}`, value);
    }
  }
  return cellMap;
}

function resolveDrawingPath(zip: AdmZip, sheetRelsXml: string): string | null {
  const doc = xmlParser.parse(sheetRelsXml) as Record<string, unknown>;
  const relationships = doc["Relationships"] as Record<string, unknown> | undefined;
  const rels = (relationships?.["Relationship"] ?? []) as unknown[];
  for (const rel of rels) {
    const r = rel as Record<string, unknown>;
    const type = r["@_Type"] as string | undefined;
    const target = r["@_Target"] as string | undefined;
    if (type?.endsWith("/drawing") && target) {
      const normalized = "xl/drawings/" + path.basename(target);
      return zip.getEntry(normalized) ? normalized : null;
    }
  }
  return null;
}

// ---- Core extract function (importable) -----------------------------------

export async function extractXlsx(
  xlsxPath: string,
  outDir: string,
  force: boolean,
  silent = false,
): Promise<ExtractSummary> {
  const log = silent ? () => {} : console.log.bind(console);
  const imgDir = path.join(outDir, "images");

  // Guard: abort if outDir already has manifest.json and --force not set
  const existingManifest = path.join(outDir, "manifest.json");
  if (fs.existsSync(existingManifest) && !force) {
    throw new Error(
      `Output already exists: ${outDir}\n` +
      `  Use --force to overwrite.`
    );
  }

  // Clear and recreate output directory
  log(`\n🗑  Clearing: ${outDir}`);
  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  fs.mkdirSync(imgDir, { recursive: true });

  log(`📂 Workbook: ${xlsxPath}`);
  log(`📦 File size: ${(fs.statSync(xlsxPath).size / 1024 / 1024).toFixed(1)} MB`);
  log("🔓 Opening ZIP...");
  const zip = new AdmZip(xlsxPath);

  const mediaEntries = zip.getEntries().filter((e) => e.entryName.startsWith("xl/media/"));
  log(`🖼  Media file count: ${mediaEntries.length}`);

  // Sheet name
  const workbookXml = zip.getEntry("xl/workbook.xml")?.getData().toString("utf-8") ?? "";
  const workbookDoc = xmlParser.parse(workbookXml) as Record<string, unknown>;
  const wb = workbookDoc["workbook"] as Record<string, unknown> | undefined;
  const sheetList = ((wb?.["sheets"] as Record<string, unknown>)?.["sheet"] ?? []) as unknown[];
  const firstSheet = (Array.isArray(sheetList) ? sheetList[0] : sheetList) as Record<string, unknown>;
  const sheetName = (firstSheet?.["@_name"] as string | undefined) ?? "Sheet1";
  log(`📋 Sheet name: ${sheetName}`);

  // Shared strings + cells
  const ssXml = zip.getEntry("xl/sharedStrings.xml")?.getData().toString("utf-8") ?? "";
  const sharedStrings = ssXml ? parseSharedStrings(ssXml) : [];
  const sheetXml = zip.getEntry("xl/worksheets/sheet1.xml")?.getData().toString("utf-8") ?? "";
  const cellMap = parseSheetCells(sheetXml, sharedStrings);

  // Drawing path + anchors
  const sheetRelsXml = zip.getEntry("xl/worksheets/_rels/sheet1.xml.rels")?.getData().toString("utf-8") ?? "";
  const drawingPath = sheetRelsXml ? resolveDrawingPath(zip, sheetRelsXml) : null;
  if (!drawingPath) throw new Error("No drawing found for sheet1");
  log(`📐 Drawing path: ${drawingPath}`);

  const drawingXml = zip.getEntry(drawingPath)?.getData().toString("utf-8") ?? "";
  const anchors = parseDrawing(drawingXml);
  log(`⚓ Image anchor count: ${anchors.length}`);

  const drawingRelsPath = drawingPath.replace("xl/drawings/", "xl/drawings/_rels/") + ".rels";
  const drawingRelsXml = zip.getEntry(drawingRelsPath)?.getData().toString("utf-8") ?? "";
  const relMap = parseDrawingRels(drawingRelsXml);

  // Pre-pass: duplicate target counts
  const rawTargetCounts = new Map<string, number>();
  for (const anchor of anchors) {
    if (anchor.col0 !== IMG_COL0) continue;
    const relTarget = relMap.get(anchor.rId) ?? "";
    if (!relTarget) continue;
    const imageTarget = "xl/" + relTarget.replace(/^\.\.\//, "");
    rawTargetCounts.set(imageTarget, (rawTargetCounts.get(imageTarget) ?? 0) + 1);
  }

  // Build records
  log("\n🔨 Building normalized records...");
  const seenRows = new Set<number>();
  const records: NormalizedRecord[] = [];

  for (const anchor of anchors) {
    if (anchor.col0 !== IMG_COL0) continue;
    if (seenRows.has(anchor.row0)) continue;
    seenRows.add(anchor.row0);
    const rowNumber = anchor.row0 + 1;
    if (rowNumber < DATA_START_ROW) continue;

    const relTarget = relMap.get(anchor.rId) ?? "";
    const imageTarget = relTarget ? "xl/" + relTarget.replace(/^\.\.\//, "") : "";
    const imageFileName = imageTarget ? path.basename(imageTarget) : "";
    const mediaEntry = imageTarget ? zip.getEntry(imageTarget) : null;
    const imageSizeBytes = mediaEntry ? mediaEntry.getData().length : 0;
    const promptEn = cellMap.get(`${rowNumber}:${EN_COL0}`) ?? "";
    const promptJa = cellMap.get(`${rowNumber}:${JA_COL0}`) ?? "";
    const outputFileName = imageFileName
      ? `row_${rowNumber}_col_${colIndexToLetter(IMG_COL0)}_${imageFileName}`
      : "";
    const outputRelativePath = outputFileName ? `images/${outputFileName}` : "";
    const targetCount = imageTarget ? (rawTargetCounts.get(imageTarget) ?? 1) : 1;
    const isDuplicateTarget = targetCount > 1;

    const flags: RecordFlag[] = [];
    let status: RecordStatus = "ready";
    if (!imageTarget || !mediaEntry) {
      status = "missing_image";
      flags.push("missing_image");
    } else {
      if (!promptEn) {
        status = "missing_prompt";
        flags.push("missing_en_prompt");
        flags.push("empty_prompt_en");
      }
      if (!promptJa) flags.push("missing_ja_prompt");
      if (!promptJa && !flags.includes("empty_prompt_en")) flags.push("empty_prompt_ja");
    }
    if (isDuplicateTarget) flags.push("duplicate_target");

    records.push({
      index: records.length + 1,
      sheetName,
      row0: anchor.row0,
      rowNumber,
      imageCol0: IMG_COL0,
      imageColumn: colIndexToLetter(IMG_COL0),
      promptEnCol0: EN_COL0,
      promptJaCol0: JA_COL0,
      imageTarget,
      imageFileName,
      imageSizeBytes,
      outputFileName,
      outputRelativePath,
      hasImage: !!mediaEntry,
      hasPromptEn: promptEn.length > 0,
      hasPromptJa: promptJa.length > 0,
      status,
      flags,
      isDuplicateTarget,
      duplicateGroupKey: isDuplicateTarget ? imageTarget : null,
      duplicateTargetCount: targetCount,
      promptEn,
      promptJa,
      promptEnPreview: previewText(promptEn),
      promptJaPreview: previewText(promptJa),
    });
  }

  const readyCount = records.filter((r) => r.status === "ready").length;
  const missingImage = records.filter((r) => !r.hasImage).length;
  const missingEn = records.filter((r) => !r.hasPromptEn).length;
  const missingJa = records.filter((r) => !r.hasPromptJa).length;
  const duplicateTargetRecords = records.filter((r) => r.isDuplicateTarget).length;
  const uniqueDuplicateTargets = new Set(
    records.filter((r) => r.isDuplicateTarget).map((r) => r.imageTarget)
  ).size;

  log(`\n📊 Normalized record count: ${records.length}`);
  log(`   ✅ ready:                  ${readyCount}`);
  log(`   ❌ missing image:          ${missingImage}`);
  log(`   ⚠️  missing EN prompt:     ${missingEn}`);
  log(`   ⚠️  missing JA prompt:     ${missingJa}`);
  log(`   🔁 duplicates:             ${duplicateTargetRecords} records (${uniqueDuplicateTargets} unique targets)`);

  log("\n📋 First 5 records preview:");
  for (const r of records.slice(0, 5)) {
    const flagStr = r.flags.length > 0 ? ` [${r.flags.join(", ")}]` : "";
    log(`  [${r.index}] row=${r.rowNumber} img=${r.imageFileName} (${(r.imageSizeBytes / 1024).toFixed(0)}KB)`);
    log(`       EN: ${r.promptEnPreview || "(empty)"}`);
    log(`       JA: ${r.promptJaPreview || "(empty)"}`);
    log(`       status: ${r.status}${flagStr}`);
  }

  // Extract renamed images only
  log(`\n💾 Extracting images to ${imgDir} ...`);
  let extractedCount = 0;
  const seenOutputNames = new Set<string>();
  for (const record of records) {
    if (!record.hasImage || !record.outputFileName) continue;
    if (seenOutputNames.has(record.outputFileName)) continue;
    seenOutputNames.add(record.outputFileName);
    const entry = zip.getEntry(record.imageTarget);
    if (!entry) continue;
    fs.writeFileSync(path.join(imgDir, record.outputFileName), entry.getData());
    extractedCount++;
  }

  const summary: ExtractSummary = {
    outDir,
    xlsxFile: path.basename(xlsxPath),
    sheetName,
    mediaFileCount: mediaEntries.length,
    anchorCount: anchors.length,
    recordCount: records.length,
    readyCount,
    missingImageCount: missingImage,
    missingEnCount: missingEn,
    missingJaCount: missingJa,
    duplicateTargetRecordCount: duplicateTargetRecords,
    uniqueDuplicateTargetCount: uniqueDuplicateTargets,
    outputImageCount: extractedCount,
    records,
  };

  // Write manifest.json
  const manifestJson = { generatedAt: new Date().toISOString(), ...summary };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifestJson, null, 2));

  // Write manifest.csv (preview only)
  const csvHeader = [
    "index", "sheet_name", "row_number", "row0",
    "image_col0", "image_column", "prompt_en_col0", "prompt_ja_col0",
    "image_filename", "image_target", "image_size_bytes",
    "output_filename", "output_relative_path",
    "has_image", "has_prompt_en", "has_prompt_ja",
    "status", "flags",
    "is_duplicate_target", "duplicate_group_key", "duplicate_target_count",
    "prompt_en_preview", "prompt_ja_preview",
  ].join(",");
  const csvRows = records.map((r) =>
    [
      r.index, `"${r.sheetName.replace(/"/g, '""')}"`, r.rowNumber, r.row0,
      r.imageCol0, `"${r.imageColumn}"`, r.promptEnCol0, r.promptJaCol0,
      `"${r.imageFileName}"`, `"${r.imageTarget}"`, r.imageSizeBytes,
      `"${r.outputFileName}"`, `"${r.outputRelativePath}"`,
      r.hasImage, r.hasPromptEn, r.hasPromptJa,
      `"${r.status}"`, `"${r.flags.join("|")}"`,
      r.isDuplicateTarget, `"${r.duplicateGroupKey ?? ""}"`, r.duplicateTargetCount,
      `"${r.promptEnPreview.replace(/"/g, '""')}"`,
      `"${r.promptJaPreview.replace(/"/g, '""')}"`,
    ].join(",")
  );
  fs.writeFileSync(path.join(outDir, "manifest.csv"), [csvHeader, ...csvRows].join("\n"));

  // Integrity check
  const hasImageCount = records.filter((r) => r.hasImage).length;
  const actualFiles = fs.readdirSync(imgDir).filter((f) => !f.startsWith(".")).length;
  log(`\n🔍 Integrity check:`);
  log(`   records with hasImage=true: ${hasImageCount}`);
  log(`   output image file count:    ${extractedCount}`);
  log(`   actual files in images/:    ${actualFiles}`);
  log(`   manifest record count:      ${records.length}`);

  const integrityWarnings: string[] = [];
  if (actualFiles !== extractedCount) {
    integrityWarnings.push(`images/ file count (${actualFiles}) !== extracted count (${extractedCount})`);
  }
  if (extractedCount !== hasImageCount && duplicateTargetRecords === 0) {
    integrityWarnings.push(`extracted (${extractedCount}) !== hasImage records (${hasImageCount})`);
  }
  if (integrityWarnings.length > 0) {
    for (const w of integrityWarnings) log(`   ⚠️  ${w}`);
  } else {
    log("   ✅ All counts consistent");
  }

  log(`\n✅ Done!`);
  log(`   manifest.json → ${path.join(outDir, "manifest.json")}`);
  log(`   manifest.csv  → ${path.join(outDir, "manifest.csv")}`);
  log(`   images/       → ${imgDir}/ (${extractedCount} files)`);

  return summary;
}

// ---- Default out-dir from XLSX path ---------------------------------------

export function defaultOutDir(xlsxPath: string, outRoot = "tmp/xlsx-extract"): string {
  return path.resolve(process.cwd(), outRoot, makeSlug(path.basename(xlsxPath)));
}

// ---- CLI entry point ------------------------------------------------------

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "out-dir": { type: "string" },
      force: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  const xlsxPath = positionals[0];
  if (!xlsxPath) {
    console.error("Usage: npm run extract:xlsx-images -- /path/to/file.xlsx [--out-dir dir] [--force]");
    process.exit(1);
  }
  if (!fs.existsSync(xlsxPath)) {
    console.error(`File not found: ${xlsxPath}`);
    process.exit(1);
  }

  const outDir = (values["out-dir"] as string | undefined) ?? defaultOutDir(xlsxPath);
  const force = (values["force"] as boolean | undefined) ?? false;

  await extractXlsx(xlsxPath, outDir, force);
}

// Only run main() when executed directly (not when imported by batch runner)
if (process.argv[1]?.endsWith("extract-xlsx-images.ts")) {
  main().catch((e) => {
    console.error("Fatal error:", e);
    process.exit(1);
  });
}
