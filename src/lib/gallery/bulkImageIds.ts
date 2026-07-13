// Pure validation/normalization for the bulk tag/person assignment routes
// (Phase 10-18B). No DOM/React/Prisma import — unit-testable. Only handles
// the imageIds ARRAY shape; workspace/ACTIVE/deleted membership is a DB
// concern the route checks separately (findMany + all-or-nothing compare).

export const BULK_IMAGE_IDS_MAX = 100;

export type NormalizeBulkImageIdsResult =
  | { ok: true; imageIds: string[]; requestedCount: number }
  | { ok: false; error: string };

/** Validates and dedupes a bulk-request imageIds array. `requestedCount` is
 *  the length of the ORIGINAL (pre-dedupe) array — callers use it to report
 *  how many ids the client asked for, distinct from how many were actually
 *  processed after dedupe. Never mutates the input. */
export function normalizeBulkImageIds(value: unknown): NormalizeBulkImageIdsResult {
  if (!Array.isArray(value)) return { ok: false, error: "imageIds must be an array" };
  if (value.length === 0) return { ok: false, error: "imageIds must not be empty" };
  if (value.length > BULK_IMAGE_IDS_MAX) {
    return { ok: false, error: `imageIds must not exceed ${BULK_IMAGE_IDS_MAX} items` };
  }

  const requestedCount = value.length;

  for (const v of value) {
    if (typeof v !== "string") return { ok: false, error: "imageIds must contain only strings" };
    if (v.trim() === "") return { ok: false, error: "imageIds must not contain empty strings" };
  }

  const imageIds = [...new Set(value as string[])];

  return { ok: true, imageIds, requestedCount };
}
