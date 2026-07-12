// Phase 10-12C: pure localStorage-backed "favorite prompts" library. No
// DOM/React import — unit-testable, client-safe. Nothing here ever reaches the
// server: this is a browser-only convenience cache, NOT a database. The
// original prompt (Prompt.currentBody) is never read or written by this file.
// Mirrors src/lib/gallery/promptVariationHistory.ts's shape/patterns, but this
// list is GLOBAL (one key, not per-image) — a favorite can be recalled
// regardless of which image's DetailPanel is currently open.
import type { VariationChange } from "./imagesClient"

export type FavoritePromptKind = "current_prompt" | "variation"

export type FavoritePromptItem = {
  id: string
  sourceImageId: string
  sourceImageName: string
  text: string
  kind: FavoritePromptKind
  changes?: VariationChange[]
  createdAt: string
}

/** Minimal storage surface (matches window.localStorage) — DI for testability. */
export type StorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const MAX_FAVORITES = 50

export function getFavoritePromptsKey(): string {
  return "photobox:favorite-prompts:v1"
}

export function formatFavoritePromptKind(kind: FavoritePromptKind): string {
  return kind === "current_prompt" ? "現在のPrompt" : "生成案"
}

export function makeFavoritePromptItem(
  args: {
    sourceImageId: string
    sourceImageName: string
    text: string
    kind: FavoritePromptKind
    changes?: VariationChange[]
  },
  now?: Date,
): FavoritePromptItem {
  const createdAt = (now ?? new Date()).toISOString()
  // id derived from timestamp + a short random suffix — collision-safe enough
  // for a max-50-item local list, no crypto import needed.
  const id = `${createdAt}-${Math.random().toString(36).slice(2, 8)}`
  return {
    id,
    sourceImageId: args.sourceImageId,
    sourceImageName: args.sourceImageName,
    text: args.text,
    kind: args.kind,
    ...(args.changes !== undefined ? { changes: args.changes } : {}),
    createdAt,
  }
}

/** Parses the stored JSON array; any failure (missing / invalid JSON / wrong
 *  shape) safely yields an empty list rather than throwing. */
function parseFavorites(raw: string | null): FavoritePromptItem[] {
  if (raw == null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is FavoritePromptItem =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as FavoritePromptItem).id === "string" &&
        typeof (item as FavoritePromptItem).text === "string",
    )
  } catch {
    return []
  }
}

/** Reads the favorites list. Never throws — a missing/unavailable storage (or
 *  a storage that throws) is treated the same as "no favorites". */
export function readFavoritePrompts(storage?: StorageLike): FavoritePromptItem[] {
  if (!storage) return []
  try {
    return parseFavorites(storage.getItem(getFavoritePromptsKey()))
  } catch {
    return []
  }
}

function writeFavorites(items: FavoritePromptItem[], storage: StorageLike): void {
  try {
    storage.setItem(getFavoritePromptsKey(), JSON.stringify(items))
  } catch {
    // Storage unavailable/full/blocked — silently ignore. The caller (UI)
    // still shows success feedback for the in-memory list; only the
    // persisted write is lost.
  }
}

/**
 * Adds a new favorite to the front of the list, capped at MAX_FAVORITES. If
 * an existing item has the same text, it is moved to the front instead of
 * duplicated. Returns the updated list (also the value now persisted, unless
 * storage is unavailable/throws).
 */
export function addFavoritePrompt(item: FavoritePromptItem, storage?: StorageLike): FavoritePromptItem[] {
  const existing = storage ? readFavoritePrompts(storage) : []
  const deduped = existing.filter((f) => f.text !== item.text)
  const next = [item, ...deduped].slice(0, MAX_FAVORITES)
  if (storage) writeFavorites(next, storage)
  return next
}

export function removeFavoritePrompt(itemId: string, storage?: StorageLike): FavoritePromptItem[] {
  const existing = storage ? readFavoritePrompts(storage) : []
  const next = existing.filter((f) => f.id !== itemId)
  if (storage) writeFavorites(next, storage)
  return next
}

export function clearFavoritePrompts(storage?: StorageLike): void {
  if (!storage) return
  try {
    storage.removeItem(getFavoritePromptsKey())
  } catch {
    // ignore — best-effort cache clear
  }
}
