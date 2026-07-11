// Phase 10-11B: pure helpers for the prompt-variation route. No Prisma, no
// server-only, no SDK — unit-testable. The route wires these to
// resolveWorkspaceImage + provider + budget (nothing is persisted).
import { isVariationChange, type VariationChange } from "./types";

export type ChangesValidation =
  | { ok: true; changes: VariationChange[] }
  | { ok: false; error: string };

/**
 * Validates the request `changes` array: required, 1–5 items, every item a
 * known enum value, no duplicates. Returns the typed array on success.
 */
export function validateChanges(raw: unknown): ChangesValidation {
  if (!Array.isArray(raw)) return { ok: false, error: "changes must be an array" };
  if (raw.length === 0) return { ok: false, error: "changes must not be empty" };
  if (raw.length > 5) return { ok: false, error: "changes must have at most 5 items" };

  const seen = new Set<string>();
  for (const item of raw) {
    if (!isVariationChange(item)) return { ok: false, error: `unknown change: ${String(item)}` };
    if (seen.has(item)) return { ok: false, error: `duplicate change: ${item}` };
    seen.add(item);
  }
  return { ok: true, changes: raw as VariationChange[] };
}

/**
 * Caps the prompt text sent to the provider (provider input only — nothing is
 * persisted here). Mirrors truncateTranslationInput.
 */
export function truncateVariationInput(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}\n\n[入力が長いためここで切り詰めました]`, truncated: true };
}

const API_KEY_PATTERN = /sk-[A-Za-z0-9_-]+/g;
const MAX_ERROR_LENGTH = 500;

/** Strips likely API keys and caps length before returning an error string. */
export function sanitizeVariationError(e: unknown): string {
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : "prompt variation failed";
  return message.replace(API_KEY_PATTERN, "[REDACTED_API_KEY]").slice(0, MAX_ERROR_LENGTH);
}
