// Pure validation/normalization for the bulk person-assignment route's
// manually-typed person name (Phase 10-18B). Kept separate from POST
// /api/persons (which has no length limit) — this bulk path introduces its
// own 40-char cap for consistency/safety, without changing the existing
// unlimited single-person-creation endpoint. No taxonomy/synonym
// normalization is applied — the trimmed input is used verbatim.

export const BULK_PERSON_NAME_MAX_LENGTH = 40;

export type NormalizeBulkPersonNameResult =
  | { ok: true; name: string }
  | { ok: false; error: string };

export function normalizeBulkPersonName(name: unknown): NormalizeBulkPersonNameResult {
  if (typeof name !== "string") return { ok: false, error: "name must be a string" };

  const trimmed = name.trim();
  if (trimmed === "") return { ok: false, error: "name is required" };

  if (trimmed.length > BULK_PERSON_NAME_MAX_LENGTH) {
    return { ok: false, error: `name must be at most ${BULK_PERSON_NAME_MAX_LENGTH} characters` };
  }

  return { ok: true, name: trimmed };
}
