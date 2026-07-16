// Pure helpers for the Gallery display-density switch (Phase 10-27B). No
// DOM/React/localStorage import — unit-testable. Actual localStorage
// read/write happens in GalleryClient.tsx (wrapped in try/catch, matching the
// pattern already used for sessionStorage in galleryScrollRestoration.ts /
// ImageGrid.tsx) — this file only defines the key, validates values, and
// converts a density to its grid/label representation.
//
// "standard" must stay pixel-identical to the pre-Phase-10-27 Gallery grid
// (grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5) so unset/legacy
// users see no visual change.

export type GalleryDensity = "comfortable" | "standard" | "compact"

export const GALLERY_DENSITY_STORAGE_KEY = "photobox:gallery-density:v1"

/** Parses a raw localStorage value into a valid density, defaulting to
 *  "standard" for anything missing/invalid (unknown string, null, undefined). */
export function parseGalleryDensity(value: string | null | undefined): GalleryDensity {
  if (value === "comfortable" || value === "standard" || value === "compact") return value
  return "standard"
}

/** Tailwind grid-cols classes per density. "standard" is intentionally
 *  identical to the original hardcoded ImageGrid classes. */
export function getGalleryDensityGridClass(density: GalleryDensity): string {
  switch (density) {
    case "comfortable":
      return "grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
    case "compact":
      return "grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8"
    case "standard":
    default:
      return "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
  }
}

/** Japanese label for density-switch UI (PC header / mobile filter drawer). */
export function getGalleryDensityLabel(density: GalleryDensity): string {
  switch (density) {
    case "comfortable":
      return "大きめ"
    case "compact":
      return "コンパクト"
    case "standard":
    default:
      return "標準"
  }
}
