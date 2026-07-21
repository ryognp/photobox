/**
 * Phase 10-37-D-B: pure predicate for QuickAddClient's global ArrowLeft/Right
 * photo-navigation shortcut. Returns true when the keydown target is a form
 * control (or contenteditable) that should keep its own native/expected
 * behavior for the arrow keys, so the shortcut must not fire.
 */
export function shouldIgnoreArrowNav(
  tagName: string | undefined | null,
  isContentEditable = false,
): boolean {
  const normalized = tagName?.toLowerCase()
  return (
    isContentEditable ||
    normalized === "textarea" ||
    normalized === "input" ||
    normalized === "select"
  )
}
