"use client"

import { useEffect, useRef, type RefObject } from "react"

/**
 * Phase 10-37-E-B: moves focus to `ref` only on the false→true rising edge of
 * `active`, never on mount (so a confirm/status panel that happens to render
 * `active=true` on first paint does not steal focus) and never while `active`
 * stays true or goes false→false. Used for destructive-confirmation phase
 * transitions (e.g. "confirm" appearing, or the trigger button reappearing
 * after "cancel"), where the previously-focused element is a different DOM
 * node each time (unlike the overlay dialogs' single persistent container),
 * so document.activeElement capture/restore (see useDialogA11y) doesn't apply
 * — the target must be re-focused explicitly by ref.
 */
export function useFocusOnActivate<T extends HTMLElement>(
  active: boolean,
  ref: RefObject<T | null>,
) {
  const previousActiveRef = useRef(active)

  useEffect(() => {
    const wasActive = previousActiveRef.current
    previousActiveRef.current = active

    if (!wasActive && active) {
      ref.current?.focus()
    }
  }, [active, ref])
}
