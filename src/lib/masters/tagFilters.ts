// Pure client-side filter for the /masters Tags tab (Phase 10-17B). No DOM/
// React import — unit-testable. GET /api/tags already applies `q` server-side
// (name search), but this helper re-applies the same query client-side so the
// "unusedOnly" toggle composes safely with whatever the caller currently has
// in state, independent of when/whether a re-fetch has happened.

export type MastersTagLike = { id: string; name: string; imageCount: number };

export type FilterTagsForMastersOptions = {
  query?: string;
  unusedOnly?: boolean;
};

/** Filters a Tags-tab list by name substring (case-insensitive) and/or
 *  imageCount === 0 ("使用数0件のみ"). Returns a new array; never mutates
 *  the input. Absent/blank query and unusedOnly:false are no-ops. */
export function filterTagsForMasters<T extends MastersTagLike>(
  tags: T[],
  options: FilterTagsForMastersOptions = {},
): T[] {
  const trimmedQuery = options.query?.trim().toLowerCase() ?? "";

  return tags.filter((tag) => {
    if (trimmedQuery !== "" && !tag.name.toLowerCase().includes(trimmedQuery)) return false;
    if (options.unusedOnly && tag.imageCount !== 0) return false;
    return true;
  });
}
