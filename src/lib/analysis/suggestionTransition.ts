// Pure decision logic for TagSuggestion approve/reject transitions (Phase
// 10-3). No Prisma import — the route maps the decision to actual DB writes.
// AI tag suggestions are never auto-promoted; only these two explicit actions
// (via the approval API) can turn a suggestion into a real Tag/ImageTag.
export type SuggestionStatus = "PENDING" | "APPROVED" | "REJECTED";
export type SuggestionAction = "approve" | "reject";

export type SuggestionTransitionInput = {
  currentStatus: SuggestionStatus;
  action: SuggestionAction;
  /** True if the caller supplied a body.label to edit-and-approve. */
  hasLabelEdit: boolean;
};

export type SuggestionTransitionResult =
  /** Perform the action (create/verify Tag+ImageTag, or mark REJECTED). */
  | { kind: "apply" }
  /** Same action on the same resulting status — no-op, return 200. */
  | { kind: "idempotent" }
  /** Action is not allowed from the current status. */
  | { kind: "conflict"; reason: string };

/**
 * Decides how to handle an approve/reject request given the suggestion's
 * current status. Label edits are only accepted while PENDING (Phase 10-3
 * decision) — an edit submitted against an already-APPROVED suggestion is
 * rejected as a conflict rather than silently ignored or silently applied.
 */
export function decideSuggestionTransition(
  input: SuggestionTransitionInput,
): SuggestionTransitionResult {
  const { currentStatus, action, hasLabelEdit } = input;

  if (action === "approve") {
    if (currentStatus === "PENDING") return { kind: "apply" };
    if (currentStatus === "REJECTED") return { kind: "apply" };
    if (currentStatus === "APPROVED") {
      if (hasLabelEdit) {
        return {
          kind: "conflict",
          reason: "Cannot edit label of an already-approved suggestion",
        };
      }
      return { kind: "idempotent" };
    }
  }

  if (action === "reject") {
    if (currentStatus === "PENDING") return { kind: "apply" };
    if (currentStatus === "REJECTED") return { kind: "idempotent" };
    if (currentStatus === "APPROVED") {
      return {
        kind: "conflict",
        reason: "Cannot reject an already-approved suggestion",
      };
    }
  }

  // Exhaustive in practice; keep a safe fallback for future statuses.
  return { kind: "conflict", reason: `Unsupported transition: ${currentStatus} -> ${action}` };
}

export const LABEL_MAX_LENGTH = 40;

export type LabelValidationResult =
  | { ok: true; label: string }
  | { ok: false; error: string };

/** Validates + normalizes an optional edit-and-approve label. */
export function validateSuggestionLabel(raw: string | undefined | null): LabelValidationResult {
  if (raw === undefined || raw === null) return { ok: true, label: "" }; // no edit requested
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, error: "label must not be empty" };
  if (trimmed.length > LABEL_MAX_LENGTH) {
    return { ok: false, error: `label must be at most ${LABEL_MAX_LENGTH} characters` };
  }
  return { ok: true, label: trimmed };
}
