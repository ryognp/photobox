import "server-only";

import Papa from "papaparse";
import * as XLSX from "xlsx";
import type { ParsedRow, ColumnMapping, ParseResult } from "./importTypes";

const MAX_ROWS = 100;
const PREVIEW_ROWS = 10;

// ---- 列名正規化 -------------------------------------------------------

function normalizeCol(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[\s_\-　]+/g, ""); // spaces, underscore, hyphen, fullwidth space
}

const AUTO_MAP: Record<keyof ColumnMapping, string[]> = {
  imageUrlColumn: ["imageurl", "url", "画像url", "画像url", "image"],
  promptColumn: ["prompt", "prompttext", "プロンプト", "prompts"],
  personColumn: ["person", "persons", "人物", "人物名"],
  sceneColumn: ["scene", "scenename", "シーン"],
  tagsColumn: ["tags", "tag", "タグ"],
  ratingColumn: ["rating", "rate", "評価", "star", "stars"],
  notesColumn: ["notes", "note", "メモ", "備考"],
};

function buildAutoMapping(columns: string[]): ColumnMapping {
  const normalized = columns.map((c) => normalizeCol(c));
  const mapping: ColumnMapping = {
    imageUrlColumn: null,
    promptColumn: null,
    personColumn: null,
    sceneColumn: null,
    tagsColumn: null,
    ratingColumn: null,
    notesColumn: null,
  };

  for (const [key, candidates] of Object.entries(AUTO_MAP) as [keyof ColumnMapping, string[]][]) {
    for (let i = 0; i < normalized.length; i++) {
      if (candidates.includes(normalized[i])) {
        mapping[key] = columns[i];
        break;
      }
    }
  }

  return mapping;
}

// ---- CSV parse --------------------------------------------------------

function parseCSV(buffer: Buffer, fileName: string): ParseResult {
  // Strip BOM if present
  const text = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
    ? buffer.slice(3).toString("utf-8")
    : buffer.toString("utf-8");

  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  const warnings: string[] = [];
  if (result.errors.length > 0) {
    warnings.push(...result.errors.slice(0, 5).map((e) => `CSV parse warning: ${e.message}`));
  }

  const columns = result.meta.fields ?? [];
  const allRows = result.data;

  if (allRows.length === 0) {
    throw new Error("DATA_EMPTY");
  }
  if (allRows.length > MAX_ROWS) {
    throw new Error(`ROW_LIMIT:${allRows.length}`);
  }

  const rows: ParsedRow[] = allRows.map((row, i) => ({ ...row, __rowNumber: i + 2 }));

  return {
    fileName,
    fileType: "csv",
    sheetName: fileName,
    rowCount: rows.length,
    columns,
    preview: rows.slice(0, PREVIEW_ROWS),
    autoMapping: buildAutoMapping(columns),
    warnings,
  };
}

// ---- XLSX parse -------------------------------------------------------

function parseXLSX(buffer: Buffer, fileName: string): ParseResult {
  const workbook = XLSX.read(buffer, { type: "buffer" });

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("DATA_EMPTY");

  const sheet = workbook.Sheets[sheetName];
  const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
    blankrows: false,
  });

  if (raw.length < 2) throw new Error("DATA_EMPTY");

  const headers = (raw[0] as unknown[]).map((h) =>
    typeof h === "string" ? h.trim() : String(h ?? "").trim()
  );

  const dataRows = raw.slice(1);

  if (dataRows.length === 0) throw new Error("DATA_EMPTY");
  if (dataRows.length > MAX_ROWS) throw new Error(`ROW_LIMIT:${dataRows.length}`);

  const rows: ParsedRow[] = dataRows.map((row, i) => {
    const cells = row as unknown[];
    const obj: ParsedRow = { __rowNumber: i + 2 };
    headers.forEach((h, idx) => {
      obj[h] = typeof cells[idx] === "undefined" || cells[idx] === null
        ? ""
        : String(cells[idx]);
    });
    return obj;
  });

  return {
    fileName,
    fileType: "xlsx",
    sheetName,
    rowCount: rows.length,
    columns: headers,
    preview: rows.slice(0, PREVIEW_ROWS),
    autoMapping: buildAutoMapping(headers),
    warnings: [],
  };
}

// ---- public entry point -----------------------------------------------

export function parseImportFile(
  buffer: Buffer,
  fileName: string,
  mimeType: string,
): ParseResult {
  const ext = fileName.split(".").pop()?.toLowerCase();
  const isXlsx =
    mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    ext === "xlsx";

  if (isXlsx) return parseXLSX(buffer, fileName);
  return parseCSV(buffer, fileName);
}
