// Pure commit pre-validation decision logic (no server-only, no Prisma/Supabase).
// Extracted from processItem() to fix current behavior under unit tests.
// Evaluation order MUST match the original processItem exactly — a single
// reorder changes the outcome for abnormal states.

/** Minimal fields needed for the pre-commit decision (no route/Prisma types). */
export type CommitDecisionInput = {
  commitStatus: string;
  committedImageId: string | null;
  duplicateStatus: string;
  duplicateImageId: string | null;
  uploadStatus: string;
  promptStatus: string;
  promptDraft: string | null;
};

export type CommitInvalidReason =
  | "SKIPPED_WITHOUT_DUPLICATE_IMAGE_ID"
  | "UPLOAD_NOT_READY"
  | "DUPLICATE_UNRESOLVED"
  | "DUPLICATE_UNCHECKED"
  | "PROMPT_NOT_FILLED"
  | "PROMPT_EMPTY"
  | "INVALID_COMMIT_STATUS";

export type CommitDecision =
  | { action: "already_committed"; imageId: string }
  | { action: "in_progress" }
  | { action: "skip_duplicate"; imageId: string }
  | { action: "invalid"; reason: CommitInvalidReason; message: string }
  | { action: "proceed" };

/**
 * Classifies an upload item into a pre-commit decision.
 * Mirrors processItem branches 1–9 in the original order.
 * DB/Storage effects (duplicate re-check, copy, transaction) stay in the route.
 */
export function classifyCommitItem(item: CommitDecisionInput): CommitDecision {
  // 1. Already committed — idempotent
  if (item.commitStatus === "COMMITTED" || item.committedImageId) {
    return { action: "already_committed", imageId: item.committedImageId ?? "" };
  }

  // 2. Still in-progress
  if (item.commitStatus === "IN_PROGRESS") {
    return { action: "in_progress" };
  }

  // 3. SKIPPED duplicate handling
  if (item.duplicateStatus === "SKIPPED") {
    if (!item.duplicateImageId) {
      return {
        action: "invalid",
        reason: "SKIPPED_WITHOUT_DUPLICATE_IMAGE_ID",
        message: "Item is SKIPPED but has no duplicateImageId",
      };
    }
    return { action: "skip_duplicate", imageId: item.duplicateImageId };
  }

  // 4. Upload readiness
  if (item.uploadStatus !== "READY") {
    return {
      action: "invalid",
      reason: "UPLOAD_NOT_READY",
      message: `uploadStatus is ${item.uploadStatus}, expected READY`,
    };
  }

  // 5. Unresolved duplicate
  if (item.duplicateStatus === "DUPLICATE") {
    return {
      action: "invalid",
      reason: "DUPLICATE_UNRESOLVED",
      message: "Item is marked as DUPLICATE. Skip it or resolve before committing.",
    };
  }

  // 6. Duplicate not yet checked
  if (item.duplicateStatus === "UNCHECKED") {
    return {
      action: "invalid",
      reason: "DUPLICATE_UNCHECKED",
      message: "Run check-duplicates before committing",
    };
  }

  // 7. Prompt not filled
  if (item.promptStatus !== "FILLED") {
    return {
      action: "invalid",
      reason: "PROMPT_NOT_FILLED",
      message: `promptStatus is ${item.promptStatus}, expected FILLED`,
    };
  }

  // 8. Prompt empty (after trim)
  const promptDraft = (item.promptDraft ?? "").trim();
  if (!promptDraft) {
    return {
      action: "invalid",
      reason: "PROMPT_EMPTY",
      message: "promptDraft is empty",
    };
  }

  // 9. Unexpected commit status
  if (item.commitStatus !== "PENDING" && item.commitStatus !== "FAILED") {
    return {
      action: "invalid",
      reason: "INVALID_COMMIT_STATUS",
      message: `commitStatus is ${item.commitStatus}, expected PENDING or FAILED`,
    };
  }

  return { action: "proceed" };
}

/** True when an IN_PROGRESS item has exceeded the commit timeout. Uses strict `<`. */
export function isCommitTimedOut(
  item: { commitStatus: string; commitStartedAt: Date | null },
  now: Date,
  timeoutMs: number,
): boolean {
  if (item.commitStatus !== "IN_PROGRESS") return false;
  if (item.commitStartedAt === null) return false;
  return item.commitStartedAt < new Date(now.getTime() - timeoutMs);
}

/** Builds the asset storage paths for a reserved image id. */
export function buildAssetPaths(args: {
  workspaceId: string;
  reservedImageId: string;
  originalExt: string;
  tempThumbnailPath: string | null;
  tempPreviewPath: string | null;
}): {
  assetStoragePath: string;
  assetThumbnailPath: string | null;
  assetPreviewPath: string | null;
} {
  const { workspaceId, reservedImageId, originalExt } = args;
  return {
    assetStoragePath: `${workspaceId}/assets/${reservedImageId}/original.${originalExt}`,
    assetThumbnailPath: args.tempThumbnailPath
      ? `${workspaceId}/assets/${reservedImageId}/thumbnail.webp`
      : null,
    assetPreviewPath: args.tempPreviewPath
      ? `${workspaceId}/assets/${reservedImageId}/preview.webp`
      : null,
  };
}
