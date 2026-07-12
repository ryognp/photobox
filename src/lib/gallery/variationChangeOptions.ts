// Phase 10-11C: pure UI helpers for the DetailPanel prompt-variation
// checkboxes. No DOM/React import — unit-testable, client-safe.
import type { VariationChange } from "./imagesClient"

/** Confirmed 5 change dimensions, in the fixed display order. */
export const VARIATION_CHANGE_OPTIONS: { value: VariationChange; label: string }[] = [
  { value: "pose", label: "ポーズを変える" },
  { value: "outfit", label: "服装を変える" },
  { value: "expression", label: "表情を変える" },
  { value: "place", label: "場所を変える" },
  { value: "mood_time", label: "雰囲気・時間帯を変える" },
]

/** Adds/removes `change` from `selected`, preserving the existing order of the rest. */
export function toggleVariationChange(
  selected: VariationChange[],
  change: VariationChange,
): VariationChange[] {
  return selected.includes(change)
    ? selected.filter((c) => c !== change)
    : [...selected, change]
}
