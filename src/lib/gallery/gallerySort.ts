// Pure helpers for the Gallery sort mode (Phase 10-29B). No DOM/React/Prisma
// import — safe on both client and server, unit-testable without a DB.
//
// "needs_review" is a SORT MODE, not a direction — unlike "newest"/"oldest"
// (which map directly to Prisma orderBy asc/desc), it drives an entirely
// different query strategy in GET /api/images (a dedicated raw-SQL path,
// first-page-only — see route.ts). Callers that need an asc/desc direction
// (e.g. for the Prisma fallback path) should derive it separately:
// `sortMode === "oldest" ? "asc" : "desc"`.

export type GallerySort = "newest" | "oldest" | "needs_review";

/** Parses a raw URL query value into a valid sort mode, defaulting to
 *  "newest" for anything missing/invalid (unknown string, null, undefined). */
export function parseGallerySort(value: string | null | undefined): GallerySort {
  if (value === "oldest" || value === "needs_review") return value;
  return "newest";
}

/** Japanese label for sort-mode UI (FilterContent's 並び順 section). */
export function getGallerySortLabel(sort: GallerySort): string {
  switch (sort) {
    case "oldest":
      return "古い順";
    case "needs_review":
      return "整理が必要な順";
    case "newest":
    default:
      return "新しい順";
  }
}
