// Pure helpers for gallery tag-filter state (Phase 10-7B). No Prisma, no DOM —
// safe to import from both the client component (GalleryClient) and the
// server route (GET /api/images).

/**
 * Merges the legacy single `tagId` query param with the new comma-separated
 * `tagIds` param into one deduped list. This is how old bookmarked/shared
 * URLs (`?tagId=xxx`) keep working after the UI moved to multi-select.
 */
export function normalizeTagIds(args: { tagId?: string | null; tagIdsParam?: string | null }): string[] {
  const fromList = (args.tagIdsParam ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const fromSingle = args.tagId?.trim() ? [args.tagId.trim()] : [];
  return Array.from(new Set([...fromList, ...fromSingle]));
}

/** Adds `id` if absent, removes it if present. Used by the FilterSidebar chip/list UI. */
export function toggleTagId(tagIds: string[], id: string): string[] {
  return tagIds.includes(id) ? tagIds.filter((t) => t !== id) : [...tagIds, id];
}
