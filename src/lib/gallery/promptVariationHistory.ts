// Phase 10-12A: pure localStorage-backed history for prompt-variation results.
// No DOM/React import — unit-testable, client-safe. Nothing here ever reaches
// the server: this is a browser-only convenience cache, NOT a database. The
// original prompt (Prompt.currentBody) is never read or written by this file.
import type { VariationChange } from "./imagesClient"
import { VARIATION_CHANGE_OPTIONS } from "./variationChangeOptions"

export type PromptVariationHistoryItem = {
  id: string
  imageId: string
  text: string
  changes: VariationChange[]
  createdAt: string
}

/** Minimal storage surface (matches window.localStorage) — DI for testability. */
export type StorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const MAX_HISTORY_ITEMS = 5

export function getPromptVariationHistoryKey(imageId: string): string {
  return `photobox:prompt-variation-history:v1:${imageId}`
}

const CHANGE_LABEL: Record<VariationChange, string> = Object.fromEntries(
  VARIATION_CHANGE_OPTIONS.map((o) => [o.value, o.label]),
) as Record<VariationChange, string>

/** Renders a compact JA label list, e.g. "ポーズを変える, 服装を変える" → "ポーズ, 服装"
 *  (trailing "を変える" dropped so history rows stay short). */
export function formatVariationChanges(changes: VariationChange[]): string {
  return changes.map((c) => CHANGE_LABEL[c].replace(/を変える$/, "")).join(", ")
}

export function makePromptVariationHistoryItem(
  imageId: string,
  text: string,
  changes: VariationChange[],
  now?: Date,
): PromptVariationHistoryItem {
  const createdAt = (now ?? new Date()).toISOString()
  // id derived from timestamp + a short random suffix — collision-safe enough
  // for a max-5-item local cache, no crypto import needed.
  const id = `${createdAt}-${Math.random().toString(36).slice(2, 8)}`
  return { id, imageId, text, changes, createdAt }
}

/** Parses the stored JSON array; any failure (missing / invalid JSON / wrong
 *  shape) safely yields an empty list rather than throwing. */
function parseHistory(raw: string | null): PromptVariationHistoryItem[] {
  if (raw == null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is PromptVariationHistoryItem =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as PromptVariationHistoryItem).id === "string" &&
        typeof (item as PromptVariationHistoryItem).text === "string",
    )
  } catch {
    return []
  }
}

/** Reads history for `imageId`. Never throws — a missing/unavailable storage
 *  (or a storage that throws) is treated the same as "no history". */
export function readPromptVariationHistory(
  imageId: string,
  storage?: StorageLike,
): PromptVariationHistoryItem[] {
  if (!storage) return []
  try {
    return parseHistory(storage.getItem(getPromptVariationHistoryKey(imageId)))
  } catch {
    return []
  }
}

function writeHistory(imageId: string, items: PromptVariationHistoryItem[], storage: StorageLike): void {
  try {
    storage.setItem(getPromptVariationHistoryKey(imageId), JSON.stringify(items))
  } catch {
    // Storage unavailable/full/blocked — silently ignore. The caller (UI)
    // still shows the generated result; only the local cache write is lost.
  }
}

/**
 * Adds a new item to the front of the history, capped at MAX_HISTORY_ITEMS.
 * If an existing item has the same text + changes, it is moved to the front
 * instead of duplicated (dedupe-by-move, per spec). Returns the updated list
 * (also the value now persisted, unless storage is unavailable/throws).
 */
export function addPromptVariationHistoryItem(
  imageId: string,
  item: PromptVariationHistoryItem,
  storage?: StorageLike,
): PromptVariationHistoryItem[] {
  const existing = storage ? readPromptVariationHistory(imageId, storage) : []
  const sameChanges = (a: VariationChange[], b: VariationChange[]) =>
    a.length === b.length && a.every((c, i) => c === b[i])
  const deduped = existing.filter((h) => !(h.text === item.text && sameChanges(h.changes, item.changes)))
  const next = [item, ...deduped].slice(0, MAX_HISTORY_ITEMS)
  if (storage) writeHistory(imageId, next, storage)
  return next
}

export function removePromptVariationHistoryItem(
  imageId: string,
  itemId: string,
  storage?: StorageLike,
): PromptVariationHistoryItem[] {
  const existing = storage ? readPromptVariationHistory(imageId, storage) : []
  const next = existing.filter((h) => h.id !== itemId)
  if (storage) writeHistory(imageId, next, storage)
  return next
}

export function clearPromptVariationHistory(imageId: string, storage?: StorageLike): void {
  if (!storage) return
  try {
    storage.removeItem(getPromptVariationHistoryKey(imageId))
  } catch {
    // ignore — best-effort cache clear
  }
}
