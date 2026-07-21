"use client"

import { useEffect, useRef, type RefObject } from "react"
import { getFocusTrapFocusTarget } from "./dialogFocusTrap"

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ")

// Deliberately layout-light: skips full computed-style checks (e.g.
// visibility:hidden) to avoid a fragile, expensive implementation. Covers the
// common cases actually seen in this app's overlays (disabled, aria-hidden,
// the [hidden] attribute, and display:none via offsetParent).
function isFocusableAndVisible(el: HTMLElement): boolean {
  if (el.closest('[aria-hidden="true"]')) return false
  if (el.closest("[hidden]")) return false
  return el.offsetParent !== null || el === document.activeElement
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    isFocusableAndVisible,
  )
}

// Phase 10-37-C-B review fix: nested-dialog ownership. A parent overlay (e.g.
// MobileDetailDrawer) and a child overlay opened inside it (e.g.
// PromptVariationModal) both register capture-phase keydown listeners on
// `document`. stopPropagation() does NOT stop sibling listeners on the same
// node, so without this guard both hooks would react to one Escape/Tab and the
// parent would close (or fight the trap) alongside the child. We resolve the
// event's nearest ancestor dialog and only act when it IS this hook's
// container, so only the innermost (front-most) dialog responds.
//
// Kept inline rather than extracted to dialogFocusTrap.ts: its substance is a
// DOM ancestor walk (Element.closest). The only pure residue is a trivial
// `===`, which is not worth a unit test and would otherwise require building a
// jsdom DOM tree — the DOM-integration testing this project deliberately avoids.
function isEventForCurrentDialog(e: KeyboardEvent, container: HTMLElement): boolean {
  const target = e.target
  if (!(target instanceof Element)) return false
  const nearestDialog = target.closest('[role="dialog"][aria-modal="true"]')
  return nearestDialog === container
}

interface UseDialogA11yOptions {
  open: boolean
  onClose: () => void
  containerRef: RefObject<HTMLElement | null>
}

/**
 * Phase 10-37-C-B: shared dialog/drawer accessibility behavior — Escape to
 * close, Tab/Shift+Tab focus trap, initial focus on the container
 * (tabIndex={-1}), and focus-return to whatever had focus before opening.
 * Does not manage body scroll lock — each overlay keeps its own existing
 * scroll-lock effect (see MobileDetailDrawer/MobileFilterDrawer/
 * PromptVariationModal), left untouched by design.
 */
export function useDialogA11y({ open, onClose, containerRef }: UseDialogA11yOptions) {
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    containerRef.current?.focus()
    return () => {
      previouslyFocusedRef.current?.focus?.()
    }
  }, [open, containerRef])

  useEffect(() => {
    if (!open) return

    const handleKeyDown = (e: KeyboardEvent) => {
      const container = containerRef.current
      if (!container) return
      // Only the innermost dialog the event originated from should react —
      // otherwise a parent dialog would also close/trap on a child's keydown.
      if (!isEventForCurrentDialog(e, container)) return

      if (e.key === "Escape") {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== "Tab") return

      const focusables = getFocusableElements(container)
      const target = getFocusTrapFocusTarget(focusables, document.activeElement, e.shiftKey)
      if (target === "none") return

      e.preventDefault()
      const el = target === "first" ? focusables[0] : focusables[focusables.length - 1]
      el?.focus()
    }

    document.addEventListener("keydown", handleKeyDown, true)
    return () => document.removeEventListener("keydown", handleKeyDown, true)
  }, [open, onClose, containerRef])
}
