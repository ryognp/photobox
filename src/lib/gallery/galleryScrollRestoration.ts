// Pure helpers for Gallery scroll-position save/restore (Phase 10-22B). No
// DOM/React/sessionStorage import — unit-testable. The client-side effect
// (reading/writing sessionStorage, attaching scroll listeners) lives in
// ImageGrid.tsx; this file only builds the storage key and validates values.
//
// Design: client-side sessionStorage only (no DB persistence). The key is
// scoped per filter (pathname + search), so switching filters never restores
// to an unrelated scroll position. Restoration is a simple scrollTop replay —
// if the saved position is deeper than what cursor pagination has loaded so
// far, the browser simply clamps to the end of the currently-loaded content
// (known limitation, intentionally not auto-fetching further pages to reach
// a saved position).

export const GALLERY_SCROLL_STORAGE_PREFIX = "photobox:gallery-scroll:v1";

/** Builds a sessionStorage key scoped to the current filter (pathname + search). */
export function buildGalleryScrollStorageKey(pathname: string, search: string): string {
  return `${GALLERY_SCROLL_STORAGE_PREFIX}:${pathname}:${search}`;
}

/** Parses a raw sessionStorage value into a valid scroll offset, or null if
 *  missing/invalid (non-numeric, negative, non-finite). */
export function parseSavedScrollY(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/** Whether a parsed scroll value is worth restoring (skips a no-op scrollTo(0)). */
export function shouldRestoreScrollY(value: number | null): boolean {
  return value !== null && value > 0;
}
