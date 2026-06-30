import path from "node:path";

/**
 * Convert an XLSX filename (or full path) into a URL-safe ASCII slug.
 *
 * Steps:
 *  1. Take the basename without extension.
 *  2. NFKD-normalize and strip combining diacritics (Unicode category M).
 *  3. Replace non-ASCII characters with `_`.
 *  4. Replace `.` and any non-`[a-zA-Z0-9_-]` character with `_`.
 *  5. Collapse runs of `_` to a single `_` and strip leading/trailing `_`.
 *  6. Lowercase.
 *  7. Slice to 80 characters.
 *  8. Fall back to `"xlsx"` if the result is empty.
 */
export function makeSlug(filename: string): string {
  // 1. basename without extension
  const base = path.basename(filename, path.extname(filename));

  // 2. NFKD + strip combining diacritics
  let s = base.normalize("NFKD").replace(/[̀-ͯ]/g, "");

  // 3. Replace non-ASCII with _
  s = s.replace(/[^\x00-\x7F]/g, "_");

  // 4. Replace . and any non-[a-zA-Z0-9_-] with _
  s = s.replace(/[^a-zA-Z0-9_-]/g, "_");

  // 5. Collapse __ → _, strip leading/trailing _
  s = s.replace(/_+/g, "_").replace(/^_+|_+$/g, "");

  // 6. Lowercase
  s = s.toLowerCase();

  // 7. Slice to 80 chars
  s = s.slice(0, 80);

  // 8. Fallback
  return s || "xlsx";
}
