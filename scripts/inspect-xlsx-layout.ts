#!/usr/bin/env npx tsx
/**
 * inspect:xlsx-layout
 *
 * Pre-import layout check: confirms that the XLSX has images in column A,
 * English prompts in column B, and Japanese prompts in column C.
 *
 * Usage:
 *   npm run inspect:xlsx-layout -- "/path/to/file.xlsx"
 */

import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";

// ---- Constants (must match extract-xlsx-images.ts) -------------------------

const DATA_START_ROW = 2;
const IMG_COL0 = 0;   // A
const EN_COL0 = 1;    // B
const JA_COL0 = 2;    // C

// ---- XML parser -------------------------------------------------------------

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  transformTagName: (tag: string) => tag.replace(/^[^:]+:/, ""),
  isArray: (tagName) =>
    ["Relationship", "oneCellAnchor", "twoCellAnchor", "row", "c", "si"].includes(tagName),
});

// ---- Helpers ----------------------------------------------------------------

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

function parseAnchors(drawingXml: string): Array<{ row0: number; col0: number; rId: string }> {
  const doc = xmlParser.parse(drawingXml) as Record<string, unknown>;
  const root = (doc["wsDr"] ?? doc[Object.keys(doc)[0]]) as Record<string, unknown>;
  if (!root) return [];
  const anchors: Array<{ row0: number; col0: number; rId: string }> = [];
  const process = (anchor: unknown) => {
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
  if (Array.isArray(oneCells)) oneCells.forEach(process);
  else if (oneCells) process(oneCells);
  if (Array.isArray(twoCells)) twoCells.forEach(process);
  else if (twoCells) process(twoCells);
  return anchors;
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
    if (t && typeof t === "object") return String((t as Record<string, unknown>)["#text"] ?? "");
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

// ---- Main -------------------------------------------------------------------

async function main() {
  const xlsxPath = process.argv[2];
  if (!xlsxPath) {
    console.error("Usage: npm run inspect:xlsx-layout -- /path/to/file.xlsx");
    process.exit(1);
  }
  if (!fs.existsSync(xlsxPath)) {
    console.error(`File not found: ${xlsxPath}`);
    process.exit(1);
  }

  console.log(`\n📋 XLSX Layout Inspector`);
  console.log(`   File: ${xlsxPath}`);
  console.log(`   Size: ${(fs.statSync(xlsxPath).size / 1024 / 1024).toFixed(1)} MB\n`);

  const zip = new AdmZip(xlsxPath);

  // Media count
  const mediaEntries = zip.getEntries().filter((e) => e.entryName.startsWith("xl/media/"));
  console.log(`mediaCount:   ${mediaEntries.length}`);

  // Drawing / anchors
  const sheetRelsXml = zip.getEntry("xl/worksheets/_rels/sheet1.xml.rels")?.getData().toString("utf-8") ?? "";
  const drawingPath = sheetRelsXml ? resolveDrawingPath(zip, sheetRelsXml) : null;

  if (!drawingPath) {
    console.log(`anchorCount:  0  (no drawing found)`);
    console.log(`\nEXPECTED LAYOUT:`);
    console.log(`  A=image:    NG`);
    console.log(`  B=EN prompt: NG`);
    console.log(`  C=JA prompt: NG`);
    console.log(`\nresult: NOT_READY`);
    console.log(`reason: No drawing XML found in sheet1`);
    process.exit(1);
  }

  const drawingXml = zip.getEntry(drawingPath)?.getData().toString("utf-8") ?? "";
  const allAnchors = parseAnchors(drawingXml);
  console.log(`anchorCount:  ${allAnchors.length}`);

  // Anchor column distribution
  const anchorColCounts = new Map<number, number>();
  for (const a of allAnchors) {
    anchorColCounts.set(a.col0, (anchorColCounts.get(a.col0) ?? 0) + 1);
  }

  // Data-row anchors
  const dataAnchors = allAnchors.filter((a) => a.row0 + 1 >= DATA_START_ROW);
  const dataAnchorColCounts = new Map<number, number>();
  for (const a of dataAnchors) {
    dataAnchorColCounts.set(a.col0, (dataAnchorColCounts.get(a.col0) ?? 0) + 1);
  }

  console.log(`\nANCHOR COLUMN COUNTS (all rows):`);
  if (anchorColCounts.size === 0) {
    console.log(`  (none)`);
  } else {
    for (const [col0, count] of [...anchorColCounts.entries()].sort((a, b) => a[0] - b[0])) {
      console.log(`  ${colIndexToLetter(col0)}: ${count}`);
    }
  }

  // Cell content column distribution
  const ssXml = zip.getEntry("xl/sharedStrings.xml")?.getData().toString("utf-8") ?? "";
  const sharedStrings = ssXml ? parseSharedStrings(ssXml) : [];
  const sheetXml = zip.getEntry("xl/worksheets/sheet1.xml")?.getData().toString("utf-8") ?? "";
  const cellMap = parseSheetCells(sheetXml, sharedStrings);

  // Count non-empty cells per column starting from DATA_START_ROW
  const cellColCounts = new Map<number, number>();
  for (const [key, value] of cellMap.entries()) {
    if (!value.trim()) continue;
    const [rowStr, col0Str] = key.split(":");
    const rowNum = parseInt(rowStr, 10);
    if (rowNum < DATA_START_ROW) continue;
    const col0 = parseInt(col0Str, 10);
    cellColCounts.set(col0, (cellColCounts.get(col0) ?? 0) + 1);
  }

  console.log(`\nCELL COLUMN COUNTS (data rows, non-empty):`);
  if (cellColCounts.size === 0) {
    console.log(`  (none)`);
  } else {
    for (const [col0, count] of [...cellColCounts.entries()].sort((a, b) => a[0] - b[0])) {
      console.log(`  ${colIndexToLetter(col0)}: ${count}`);
    }
  }

  // Expected layout checks
  const anchorInA = dataAnchorColCounts.get(IMG_COL0) ?? 0;
  const cellsInB = cellColCounts.get(EN_COL0) ?? 0;
  const cellsInC = cellColCounts.get(JA_COL0) ?? 0;

  const imageOk = anchorInA > 0;
  const enOk = cellsInB > 0;
  const jaOk = cellsInC > 0;

  console.log(`\nEXPECTED LAYOUT:`);
  console.log(`  A=image:     ${imageOk ? "OK" : "NG"}  (${anchorInA} anchors in A)`);
  console.log(`  B=EN prompt: ${enOk ? "OK" : "NG"}  (${cellsInB} cells in B)`);
  console.log(`  C=JA prompt: ${jaOk ? "OK" : "NG"}  (${cellsInC} cells in C)`);

  const allOk = imageOk && enOk && jaOk;

  if (allOk) {
    console.log(`\nresult: READY_FOR_EXTRACT`);
    process.exit(0);
  } else {
    console.log(`\nresult: NOT_READY`);
    const reasons: string[] = [];
    if (!imageOk) {
      const anchorCols = [...dataAnchorColCounts.entries()]
        .map(([c]) => colIndexToLetter(c))
        .join(", ");
      reasons.push(
        anchorCols
          ? `images are anchored to column(s) ${anchorCols}, expected A`
          : "no image anchors found in data rows",
      );
    }
    if (!enOk) reasons.push("no text content in column B (expected EN prompt)");
    if (!jaOk) reasons.push("no text content in column C (expected JA prompt)");
    for (const r of reasons) console.log(`reason: ${r}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
