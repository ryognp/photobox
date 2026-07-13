// Pure filter for the Gallery bulk-person-assignment select panel (Phase
// 10-21A). No DOM/React import — unit-testable. Narrows an existing-Person
// list by a case-insensitive name substring query.

export function filterPersonsForBulkSelect<T extends { name: string }>(
  persons: T[],
  query: string,
): T[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed === "") return persons;
  return persons.filter((p) => p.name.toLowerCase().includes(trimmed));
}
