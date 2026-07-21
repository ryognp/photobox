/**
 * Phase 10-37-C-B: pure focus-trap decision logic for dialog/drawer overlays.
 * The dialog container itself uses tabIndex={-1} as the initial-focus target,
 * so it is intentionally NOT included in `focusables` — a Shift+Tab from that
 * container lands with activeElement outside the focusables list, which must
 * still wrap to the last element rather than escaping to the background.
 */

export type FocusTrapTarget = "none" | "first" | "last"

export function getFocusTrapFocusTarget(
  focusables: readonly unknown[],
  activeElement: unknown,
  shiftKey: boolean,
): FocusTrapTarget {
  if (focusables.length === 0) return "none"

  const activeIndex = focusables.indexOf(activeElement)
  if (activeIndex === -1) {
    return shiftKey ? "last" : "first"
  }

  const isFirst = activeIndex === 0
  const isLast = activeIndex === focusables.length - 1
  if (shiftKey && isFirst) return "last"
  if (!shiftKey && isLast) return "first"
  return "none"
}
