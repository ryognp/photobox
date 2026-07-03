import { describe, it, expect } from "vitest";
import {
  classifyCommitItem,
  isCommitTimedOut,
  buildAssetPaths,
  type CommitDecisionInput,
} from "@/lib/commit/commitDecision";

// Baseline: a valid "proceed" item; override per test.
function input(overrides: Partial<CommitDecisionInput> = {}): CommitDecisionInput {
  return {
    commitStatus: "PENDING",
    committedImageId: null,
    duplicateStatus: "CLEAN",
    duplicateImageId: null,
    uploadStatus: "READY",
    promptStatus: "FILLED",
    promptDraft: "a prompt",
    ...overrides,
  };
}

describe("classifyCommitItem — already_committed", () => {
  it("COMMITTED with committedImageId", () => {
    expect(classifyCommitItem(input({ commitStatus: "COMMITTED", committedImageId: "img1" })))
      .toEqual({ action: "already_committed", imageId: "img1" });
  });

  it("COMMITTED without committedImageId → imageId '' (current behavior)", () => {
    expect(classifyCommitItem(input({ commitStatus: "COMMITTED", committedImageId: null })))
      .toEqual({ action: "already_committed", imageId: "" });
  });

  it("committedImageId present even when commitStatus is PENDING", () => {
    expect(classifyCommitItem(input({ commitStatus: "PENDING", committedImageId: "img2" })))
      .toEqual({ action: "already_committed", imageId: "img2" });
  });
});

describe("classifyCommitItem — in_progress", () => {
  it("IN_PROGRESS → in_progress", () => {
    expect(classifyCommitItem(input({ commitStatus: "IN_PROGRESS" })))
      .toEqual({ action: "in_progress" });
  });
});

describe("classifyCommitItem — skipped duplicate", () => {
  it("SKIPPED without duplicateImageId → invalid", () => {
    expect(classifyCommitItem(input({ duplicateStatus: "SKIPPED", duplicateImageId: null })))
      .toEqual({
        action: "invalid",
        reason: "SKIPPED_WITHOUT_DUPLICATE_IMAGE_ID",
        message: "Item is SKIPPED but has no duplicateImageId",
      });
  });

  it("SKIPPED with duplicateImageId → skip_duplicate", () => {
    expect(classifyCommitItem(input({ duplicateStatus: "SKIPPED", duplicateImageId: "dup1" })))
      .toEqual({ action: "skip_duplicate", imageId: "dup1" });
  });
});

describe("classifyCommitItem — invalid gates", () => {
  it("uploadStatus != READY → UPLOAD_NOT_READY", () => {
    const d = classifyCommitItem(input({ uploadStatus: "UPLOADING" }));
    expect(d).toEqual({
      action: "invalid",
      reason: "UPLOAD_NOT_READY",
      message: "uploadStatus is UPLOADING, expected READY",
    });
  });

  it("duplicateStatus DUPLICATE → DUPLICATE_UNRESOLVED", () => {
    const d = classifyCommitItem(input({ duplicateStatus: "DUPLICATE" }));
    expect(d).toEqual({
      action: "invalid",
      reason: "DUPLICATE_UNRESOLVED",
      message: "Item is marked as DUPLICATE. Skip it or resolve before committing.",
    });
  });

  it("duplicateStatus UNCHECKED → DUPLICATE_UNCHECKED", () => {
    const d = classifyCommitItem(input({ duplicateStatus: "UNCHECKED" }));
    expect(d).toEqual({
      action: "invalid",
      reason: "DUPLICATE_UNCHECKED",
      message: "Run check-duplicates before committing",
    });
  });

  it("promptStatus != FILLED → PROMPT_NOT_FILLED", () => {
    const d = classifyCommitItem(input({ promptStatus: "EMPTY" }));
    expect(d).toEqual({
      action: "invalid",
      reason: "PROMPT_NOT_FILLED",
      message: "promptStatus is EMPTY, expected FILLED",
    });
  });

  it("promptDraft null → PROMPT_EMPTY", () => {
    expect(classifyCommitItem(input({ promptDraft: null })).action).toBe("invalid");
    expect(classifyCommitItem(input({ promptDraft: null }))).toMatchObject({ reason: "PROMPT_EMPTY" });
  });

  it("promptDraft empty string → PROMPT_EMPTY", () => {
    expect(classifyCommitItem(input({ promptDraft: "" }))).toMatchObject({ reason: "PROMPT_EMPTY" });
  });

  it("promptDraft whitespace → PROMPT_EMPTY", () => {
    expect(classifyCommitItem(input({ promptDraft: "   \n\t" }))).toMatchObject({ reason: "PROMPT_EMPTY" });
  });

  it("commitStatus not PENDING/FAILED → INVALID_COMMIT_STATUS", () => {
    const d = classifyCommitItem(input({ commitStatus: "WEIRD" }));
    expect(d).toEqual({
      action: "invalid",
      reason: "INVALID_COMMIT_STATUS",
      message: "commitStatus is WEIRD, expected PENDING or FAILED",
    });
  });
});

describe("classifyCommitItem — proceed", () => {
  it("PENDING + READY + CLEAN + FILLED + non-empty prompt → proceed", () => {
    expect(classifyCommitItem(input())).toEqual({ action: "proceed" });
  });

  it("same but FAILED → proceed", () => {
    expect(classifyCommitItem(input({ commitStatus: "FAILED" }))).toEqual({ action: "proceed" });
  });
});

describe("classifyCommitItem — priority (evaluation order)", () => {
  it("COMMITTED beats uploadStatus not READY", () => {
    expect(classifyCommitItem(input({ commitStatus: "COMMITTED", committedImageId: "i", uploadStatus: "UPLOADING" })))
      .toEqual({ action: "already_committed", imageId: "i" });
  });

  it("committedImageId beats duplicateStatus DUPLICATE", () => {
    expect(classifyCommitItem(input({ committedImageId: "i", duplicateStatus: "DUPLICATE" })))
      .toEqual({ action: "already_committed", imageId: "i" });
  });

  it("SKIPPED (with id) beats uploadStatus not READY", () => {
    expect(classifyCommitItem(input({ duplicateStatus: "SKIPPED", duplicateImageId: "d", uploadStatus: "UPLOADING" })))
      .toEqual({ action: "skip_duplicate", imageId: "d" });
  });

  it("PROMPT_NOT_FILLED beats PROMPT_EMPTY", () => {
    expect(classifyCommitItem(input({ promptStatus: "EMPTY", promptDraft: "" })))
      .toMatchObject({ reason: "PROMPT_NOT_FILLED" });
  });
});

describe("isCommitTimedOut", () => {
  const now = new Date("2026-07-01T00:10:00.000Z");
  const TIMEOUT = 5 * 60 * 1000;

  it("5 min + 1ms elapsed → true", () => {
    const startedAt = new Date(now.getTime() - TIMEOUT - 1);
    expect(isCommitTimedOut({ commitStatus: "IN_PROGRESS", commitStartedAt: startedAt }, now, TIMEOUT)).toBe(true);
  });

  it("exactly 5 min elapsed → false (strict <)", () => {
    const startedAt = new Date(now.getTime() - TIMEOUT);
    expect(isCommitTimedOut({ commitStatus: "IN_PROGRESS", commitStartedAt: startedAt }, now, TIMEOUT)).toBe(false);
  });

  it("less than 5 min → false", () => {
    const startedAt = new Date(now.getTime() - TIMEOUT + 1000);
    expect(isCommitTimedOut({ commitStatus: "IN_PROGRESS", commitStartedAt: startedAt }, now, TIMEOUT)).toBe(false);
  });

  it("commitStartedAt null → false", () => {
    expect(isCommitTimedOut({ commitStatus: "IN_PROGRESS", commitStartedAt: null }, now, TIMEOUT)).toBe(false);
  });

  it("commitStatus not IN_PROGRESS → false", () => {
    const startedAt = new Date(now.getTime() - TIMEOUT - 10000);
    expect(isCommitTimedOut({ commitStatus: "PENDING", commitStartedAt: startedAt }, now, TIMEOUT)).toBe(false);
  });
});

describe("buildAssetPaths", () => {
  const base = { workspaceId: "w1", reservedImageId: "r1", originalExt: "jpg" };

  it("both thumbnail and preview present", () => {
    expect(buildAssetPaths({ ...base, tempThumbnailPath: "t", tempPreviewPath: "p" })).toEqual({
      assetStoragePath: "w1/assets/r1/original.jpg",
      assetThumbnailPath: "w1/assets/r1/thumbnail.webp",
      assetPreviewPath: "w1/assets/r1/preview.webp",
    });
  });

  it("thumbnail only", () => {
    expect(buildAssetPaths({ ...base, tempThumbnailPath: "t", tempPreviewPath: null })).toEqual({
      assetStoragePath: "w1/assets/r1/original.jpg",
      assetThumbnailPath: "w1/assets/r1/thumbnail.webp",
      assetPreviewPath: null,
    });
  });

  it("preview only", () => {
    expect(buildAssetPaths({ ...base, tempThumbnailPath: null, tempPreviewPath: "p" })).toEqual({
      assetStoragePath: "w1/assets/r1/original.jpg",
      assetThumbnailPath: null,
      assetPreviewPath: "w1/assets/r1/preview.webp",
    });
  });

  it("neither present", () => {
    expect(buildAssetPaths({ ...base, tempThumbnailPath: null, tempPreviewPath: null })).toEqual({
      assetStoragePath: "w1/assets/r1/original.jpg",
      assetThumbnailPath: null,
      assetPreviewPath: null,
    });
  });

  it("uses originalExt verbatim (no sanitize)", () => {
    expect(
      buildAssetPaths({ workspaceId: "w1", reservedImageId: "r1", originalExt: "JPEG", tempThumbnailPath: null, tempPreviewPath: null })
        .assetStoragePath,
    ).toBe("w1/assets/r1/original.JPEG");
  });
});
