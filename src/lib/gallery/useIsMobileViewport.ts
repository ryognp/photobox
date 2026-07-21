"use client"

import { useEffect, useState } from "react"

/** Tailwind md = 768px, so mobile (dialog-mode) is anything below it. */
export const MOBILE_DIALOG_QUERY = "(max-width: 767px)"

/**
 * Phase 10-37-C-C-B: reports whether the viewport is below Tailwind's md
 * breakpoint. Used by BulkSelectionToolbar to apply dialog semantics (role,
 * aria-modal, focus trap) to its bottom sheet ONLY on mobile — on desktop the
 * same DOM is an inline expand-in-place panel that must not be a modal.
 *
 * Starts false so SSR / the first client render assume desktop (no dialog
 * attributes); the effect corrects it after mount. This is safe here because
 * the sheet only mounts on user interaction (openPanel !== null), long after
 * this hook has settled, so there is no hydration flash.
 */
export function useIsMobileViewport(): boolean {
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_DIALOG_QUERY)
    const update = () => setIsMobile(mql.matches)
    update()
    mql.addEventListener("change", update)
    return () => mql.removeEventListener("change", update)
  }, [])

  return isMobile
}
