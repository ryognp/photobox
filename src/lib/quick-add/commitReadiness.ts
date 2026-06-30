export type CommitBlockReason = {
  code:
    | "UPLOAD_ERROR"
    | "UPLOAD_NOT_READY"
    | "PROMPT_MISSING"
    | "DUPLICATE_UNRESOLVED"
    | "DUPLICATE_UNCHECKED"
    | "COMMIT_IN_PROGRESS";
  count: number;
  message: string;
};

export type CommitSummary = {
  total: number;
  ready: number;
  filled: number;
  missingPrompt: number;
  duplicate: number;
  skipped: number;
  errors: number;
  committable: number;
};

export type CommitReadiness = {
  canCommit: boolean;
  reasons: CommitBlockReason[];
  summary: CommitSummary;
};

export function checkCommitReadiness(items: Record<string, unknown>[]): CommitReadiness {
  const activeItems = items.filter((i) => i.commitStatus !== "COMMITTED");

  const errors = activeItems.filter((i) => i.uploadStatus === "ERROR");
  const notReady = activeItems.filter(
    (i) => i.uploadStatus !== "READY" && i.uploadStatus !== "ERROR"
  );
  const missingPrompt = activeItems.filter(
    (i) =>
      i.uploadStatus === "READY" &&
      i.promptStatus !== "FILLED" &&
      i.duplicateStatus !== "SKIPPED"
  );
  const duplicateUnresolved = activeItems.filter((i) => i.duplicateStatus === "DUPLICATE");
  const duplicateUnchecked = activeItems.filter(
    (i) => i.uploadStatus === "READY" && i.duplicateStatus === "UNCHECKED"
  );
  const inProgress = activeItems.filter((i) => i.commitStatus === "IN_PROGRESS");
  const skipped = activeItems.filter((i) => i.duplicateStatus === "SKIPPED");
  const committable = activeItems.filter(
    (i) =>
      i.uploadStatus === "READY" &&
      i.promptStatus === "FILLED" &&
      (i.duplicateStatus === "CLEAN" || i.duplicateStatus === "SKIPPED")
  );

  const ready = activeItems.filter((i) => i.uploadStatus === "READY");
  const filled = activeItems.filter((i) => i.promptStatus === "FILLED");

  const reasons: CommitBlockReason[] = [];

  if (errors.length > 0) {
    reasons.push({
      code: "UPLOAD_ERROR",
      count: errors.length,
      message: `${errors.length} item${errors.length === 1 ? "" : "s"} failed to upload.`,
    });
  }

  if (notReady.length > 0) {
    reasons.push({
      code: "UPLOAD_NOT_READY",
      count: notReady.length,
      message: `${notReady.length} item${notReady.length === 1 ? " is" : "s are"} still uploading.`,
    });
  }

  if (missingPrompt.length > 0) {
    reasons.push({
      code: "PROMPT_MISSING",
      count: missingPrompt.length,
      message: `${missingPrompt.length} item${missingPrompt.length === 1 ? " is" : "s are"} missing a prompt.`,
    });
  }

  if (duplicateUnchecked.length > 0) {
    reasons.push({
      code: "DUPLICATE_UNCHECKED",
      count: duplicateUnchecked.length,
      message: `重複チェックが未実施です。「重複チェック実行」を押してください。`,
    });
  }

  if (duplicateUnresolved.length > 0) {
    reasons.push({
      code: "DUPLICATE_UNRESOLVED",
      count: duplicateUnresolved.length,
      message: `${duplicateUnresolved.length} duplicate${duplicateUnresolved.length === 1 ? "" : "s"} need to be resolved.`,
    });
  }

  if (inProgress.length > 0) {
    reasons.push({
      code: "COMMIT_IN_PROGRESS",
      count: inProgress.length,
      message: `${inProgress.length} item${inProgress.length === 1 ? " is" : "s are"} already being committed.`,
    });
  }

  const canCommit =
    reasons.length === 0 &&
    activeItems.length > 0 &&
    committable.length === activeItems.length;

  const summary: CommitSummary = {
    total: activeItems.length,
    ready: ready.length,
    filled: filled.length,
    missingPrompt: missingPrompt.length,
    duplicate: duplicateUnresolved.length,
    skipped: skipped.length,
    errors: errors.length,
    committable: committable.length,
  };

  return { canCommit, reasons, summary };
}
