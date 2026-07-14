// Pure filter for the Gallery bulk-tag-assignment select panel (Phase
// 10-22A). No DOM/React import — unit-testable. Narrows an existing-Tag
// list by a case-insensitive name substring query. Mirrors
// personSelectFilter.ts's filterPersonsForBulkSelect.

export function filterTagsForBulkSelect<T extends { name: string }>(
  tags: T[],
  query: string,
): T[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed === "") return tags;
  return tags.filter((t) => t.name.toLowerCase().includes(trimmed));
}
