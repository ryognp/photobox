// Pure state-update helpers for Gallery multi-select (Phase 10-18C). Kept out
// of GalleryClient so the toggle/reconcile logic is unit-testable without
// React. Selection is a string[] of image ids (order-preserving), distinct
// from GalleryClient's single `selectedId` (which drives the DetailPanel).

/** Toggles an image id in the selection: adds if absent, removes if present.
 *  Returns a new array (never mutates). Never produces duplicates. */
export function toggleBulkSelectedId(selectedIds: string[], imageId: string): string[] {
  return selectedIds.includes(imageId)
    ? selectedIds.filter((id) => id !== imageId)
    : [...selectedIds, imageId];
}

/** The empty selection. */
export function clearBulkSelectedIds(): string[] {
  return [];
}

/** Drops any selected id that is no longer among the currently-visible images
 *  (e.g. after a filter/sort/search re-fetch, or a delete). Preserves the
 *  order of the remaining selected ids. Returns a new array (never mutates). */
export function reconcileBulkSelectedIds(selectedIds: string[], visibleImageIds: string[]): string[] {
  const visible = new Set(visibleImageIds);
  return selectedIds.filter((id) => visible.has(id));
}
