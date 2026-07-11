// Phase 10-11B: shared types for the Detail prompt-variation generator.
// Pure types only — no runtime deps, importable from both client and server.

/** The change dimensions the user can select in the Detail UI (Phase 10-11C).
 *  Fixed enum only — free-form instructions are intentionally NOT accepted, to
 *  keep prompt-injection surface out of the generator. */
export type VariationChange = "pose" | "outfit" | "expression" | "place" | "mood_time";

/** All valid changes, in canonical order (used for validation + prompt rendering). */
export const VARIATION_CHANGES: readonly VariationChange[] = [
  "pose",
  "outfit",
  "expression",
  "place",
  "mood_time",
] as const;

export function isVariationChange(v: unknown): v is VariationChange {
  return typeof v === "string" && (VARIATION_CHANGES as readonly string[]).includes(v);
}
