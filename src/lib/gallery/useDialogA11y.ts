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
      if (e.key === "Escape") {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== "Tab") return

      const container = containerRef.current
      if (!container) return

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
