// Pure state-update helper for DetailPanel person assignment (Phase 10-15C).
// Kept out of the client component so the dedup logic is unit-testable
// without importing React. removeTagById (tagState.ts) is generic enough to
// be reused as-is for person removal — no separate remove helper here.

/** Returns a new list with `item` appended, unless an entry with the same id
 *  already exists (no-op — the API is idempotent, but UI state should never
 *  show the same person twice either). */
export function addUniqueById<T extends { id: string }>(list: T[], item: T): T[] {
  if (list.some((existing) => existing.id === item.id)) return list
  return [...list, item]
}
