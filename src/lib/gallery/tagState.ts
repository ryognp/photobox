// Pure state-update helpers for gallery tag management (Phase 10-6B). Kept
// out of the client component so the logic is unit-testable without importing
// React / next navigation. Used by GalleryClient's tag_removed reducer case.

/** Returns a new list with the tag matching `tagId` removed (no-op if absent). */
export function removeTagById<T extends { id: string }>(tags: T[], tagId: string): T[] {
  return tags.filter((t) => t.id !== tagId);
}
