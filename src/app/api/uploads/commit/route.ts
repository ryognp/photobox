import "server-only";

export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, Errors } from "@/lib/apiResponse";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { buildImageSearchText } from "@/lib/commit/searchText";
import { copyStorageFile } from "@/lib/commit/storageCopy";
import type { CommitItemResult, CommitResponse } from "@/lib/commit/commitTypes";
import { createPerfLog } from "@/lib/perfLog";

const COMMIT_CONCURRENCY = 2;

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 25);
}

// Full item shape from DB for commit processing
type CommitItem = {
  id: string;
  workspaceId: string;
  sessionId: string;
  originalName: string;
  originalExt: string;
  mimeType: string;
  fileSizeBytes: number;
  widthPx: number | null;
  heightPx: number | null;
  fileHash: string;
  tempStoragePath: string;
  tempThumbnailPath: string | null;
  tempPreviewPath: string | null;
  uploadStatus: string;
  promptStatus: string;
  duplicateStatus: string;
  duplicateImageId: string | null;
  commitStatus: string;
  commitStartedAt: Date | null;
  reservedImageId: string | null;
  assetStoragePath: string | null;
  assetThumbnailPath: string | null;
  assetPreviewPath: string | null;
  committedImageId: string | null;
  committedAt: Date | null;
  promptDraft: string | null;
  sceneId: string | null;
  rating: number | null;
  isFavorite: boolean;
  notes: string | null;
  scene: { id: string; name: string } | null;
  tags: Array<{ tag: { id: string; name: string } }>;
  persons: Array<{ person: { id: string; name: string } }>;
};

const COMMIT_ITEM_SELECT = {
  id: true,
  workspaceId: true,
  sessionId: true,
  originalName: true,
  originalExt: true,
  mimeType: true,
  fileSizeBytes: true,
  widthPx: true,
  heightPx: true,
  fileHash: true,
  tempStoragePath: true,
  tempThumbnailPath: true,
  tempPreviewPath: true,
  uploadStatus: true,
  promptStatus: true,
  duplicateStatus: true,
  duplicateImageId: true,
  commitStatus: true,
  commitStartedAt: true,
  reservedImageId: true,
  assetStoragePath: true,
  assetThumbnailPath: true,
  assetPreviewPath: true,
  committedImageId: true,
  committedAt: true,
  promptDraft: true,
  sceneId: true,
  rating: true,
  isFavorite: true,
  notes: true,
  scene: { select: { id: true, name: true } },
  tags: { select: { tag: { select: { id: true, name: true } } } },
  persons: { select: { person: { select: { id: true, name: true } } } },
} as const;


async function processItemsWithLimitedConcurrency(
  items: CommitItem[],
  workspaceId: string,
): Promise<CommitItemResult[]> {
  const results: Array<CommitItemResult | undefined> = new Array(items.length);
  const activeHashes = new Set<string>();
  let activeCount = 0;
  let completedCount = 0;

  return new Promise((resolve) => {
    function launchNext() {
      while (activeCount < COMMIT_CONCURRENCY && completedCount < items.length) {
        let selectedIndex = -1;

        for (let i = 0; i < items.length; i += 1) {
          if (results[i]) continue;
          const item = items[i];
          if (activeHashes.has(item.fileHash)) continue;
          selectedIndex = i;
          break;
        }

        if (selectedIndex === -1) break;

        const item = items[selectedIndex];
        activeHashes.add(item.fileHash);
        activeCount += 1;

        processItem(item, workspaceId)
          .then((result) => {
            results[selectedIndex] = result;
          })
          .catch((error: unknown) => {
            results[selectedIndex] = {
              kind: "failed",
              uploadItemId: item.id,
              reason: "COMMIT_PROCESS_FAILED",
              message: error instanceof Error ? error.message : "Unknown commit processing error",
            };
          })
          .finally(() => {
            activeHashes.delete(item.fileHash);
            activeCount -= 1;
            completedCount += 1;

            if (completedCount === items.length) {
              resolve(results as CommitItemResult[]);
              return;
            }

            launchNext();
          });
      }
    }

    if (items.length === 0) {
      resolve([]);
      return;
    }

    launchNext();
  });
}

export async function POST(req: NextRequest) {
  const perf = createPerfLog("uploads.commit");

  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Errors.validation("Invalid JSON body");
  }

  if (typeof body !== "object" || body === null) {
    return Errors.validation("Request body must be an object");
  }

  const { sessionId, itemIds: rawItemIds } = body as Record<string, unknown>;

  if (!sessionId || typeof sessionId !== "string") {
    return Errors.validation("sessionId is required and must be a string");
  }

  // Validate itemIds if provided
  let requestedItemIds: string[] | null = null;
  if (rawItemIds !== undefined && rawItemIds !== null) {
    if (
      !Array.isArray(rawItemIds) ||
      rawItemIds.length === 0 ||
      !rawItemIds.every((id) => typeof id === "string")
    ) {
      return Errors.validation("itemIds must be a non-empty array of strings");
    }
    requestedItemIds = rawItemIds as string[];
  }

  // Fetch session
  const session = await prisma.uploadSession.findUnique({
    where: { id: sessionId },
    select: { id: true, workspaceId: true, userId: true, status: true },
  });

  if (!session) return Errors.notFound("Session not found");
  if (session.userId !== user.id) return Errors.forbidden();

  // Workspace membership check
  const member = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: { workspaceId: session.workspaceId, userId: user.id },
    },
  });
  if (!member) return Errors.forbidden();

  // Session status check
  if (session.status === "ABANDONED") {
    return Errors.validation("Session is abandoned and cannot be committed");
  }
  if (session.status === "ACTIVE") {
    return Errors.validation(
      "Session must be in PREVIEWING status to commit. Navigate to CommitPreview first."
    );
  }
  // COMMITTED or PREVIEWING: fall through and process
  perf.mark("authSessionMs");

  // Fetch items
  const whereClause = requestedItemIds
    ? {
        id: { in: requestedItemIds },
        sessionId: session.id,
        workspaceId: session.workspaceId,
      }
    : {
        sessionId: session.id,
        workspaceId: session.workspaceId,
      };

  const items = await prisma.uploadItem.findMany({
    where: whereClause,
    select: COMMIT_ITEM_SELECT,
    orderBy: { sortOrder: "asc" },
  });

  // Validate that requested itemIds all belong to this session
  if (requestedItemIds && items.length !== requestedItemIds.length) {
    const foundIds = new Set(items.map((i) => i.id));
    const missing = requestedItemIds.filter((id) => !foundIds.has(id));
    return Errors.validation(
      `Some itemIds not found in this session: ${missing.join(", ")}`
    );
  }

  perf.mark("fetchItemsMs");

  // Reset IN_PROGRESS items that timed out (> 5 min)
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  const timedOutIds = items
    .filter(
      (i) =>
        i.commitStatus === "IN_PROGRESS" &&
        i.commitStartedAt !== null &&
        i.commitStartedAt < fiveMinutesAgo
    )
    .map((i) => i.id);

  if (timedOutIds.length > 0) {
    await prisma.uploadItem.updateMany({
      where: { id: { in: timedOutIds } },
      data: { commitStatus: "FAILED", commitError: "Timed out" },
    });
    // Patch in-memory so processItem sees updated status
    for (const item of items) {
      if (timedOutIds.includes(item.id)) {
        item.commitStatus = "FAILED";
        item.commitStartedAt = null;
      }
    }
  }

  perf.mark("timeoutResetMs");

  // Process items with limited concurrency.
  // 同じ fileHash は同時処理しないことで、commit 時の重複レースを避ける。
  const results = await processItemsWithLimitedConcurrency(items, session.workspaceId);
  perf.mark("processItemsMs");

  // Check if all session items are committed and update session status
  const allItems = await prisma.uploadItem.findMany({
    where: { sessionId: session.id, workspaceId: session.workspaceId },
    select: { commitStatus: true },
  });
  const allCommitted = allItems.every((i) => i.commitStatus === "COMMITTED");
  let finalSessionStatus = session.status;
  if (allCommitted && session.status !== "COMMITTED") {
    await prisma.uploadSession.update({
      where: { id: session.id },
      data: { status: "COMMITTED", committedAt: new Date() },
    });
    finalSessionStatus = "COMMITTED";
  }

  perf.mark("sessionFinalizeMs");

  // Build typed result buckets
  const committed = results
    .filter((r): r is Extract<CommitItemResult, { kind: "committed" }> => r.kind === "committed")
    .map((r) => ({ uploadItemId: r.uploadItemId, imageId: r.imageId, status: "committed" as const }));

  const skipped = results
    .filter((r): r is Extract<CommitItemResult, { kind: "skipped" }> => r.kind === "skipped")
    .map((r) => ({ uploadItemId: r.uploadItemId, imageId: r.imageId, status: "skipped_duplicate" as const }));

  const alreadyCommitted = results
    .filter((r): r is Extract<CommitItemResult, { kind: "already_committed" }> => r.kind === "already_committed")
    .map((r) => ({ uploadItemId: r.uploadItemId, imageId: r.imageId, status: "already_committed" as const }));

  const failed = results
    .filter((r): r is Extract<CommitItemResult, { kind: "failed" }> => r.kind === "failed")
    .map((r) => ({ uploadItemId: r.uploadItemId, reason: r.reason, message: r.message }));

  const invalid = results
    .filter((r): r is Extract<CommitItemResult, { kind: "invalid" }> => r.kind === "invalid")
    .map((r) => ({ uploadItemId: r.uploadItemId, reason: r.reason, message: r.message }));

  const response: CommitResponse = {
    summary: {
      requested: results.length,
      committed: committed.length,
      skipped: skipped.length,
      alreadyCommitted: alreadyCommitted.length,
      failed: failed.length,
      invalid: invalid.length,
    },
    committed,
    skipped,
    alreadyCommitted,
    failed,
    invalid,
    session: { id: session.id, status: finalSessionStatus },
  };

  perf.mark("serializeMs");
  perf.end({
    itemCount: items.length,
    concurrency: COMMIT_CONCURRENCY,
    timedOutCount: timedOutIds.length,
    committed: committed.length,
    skipped: skipped.length,
    alreadyCommitted: alreadyCommitted.length,
    failed: failed.length,
    invalid: invalid.length,
    finalSessionCommitted: finalSessionStatus === "COMMITTED",
  });

  return ok(response);
}

async function processItem(
  item: CommitItem,
  workspaceId: string
): Promise<CommitItemResult> {
  const uploadItemId = item.id;

  // Already committed — idempotent
  if (item.commitStatus === "COMMITTED" || item.committedImageId) {
    return {
      kind: "already_committed",
      uploadItemId,
      imageId: item.committedImageId ?? "",
    };
  }

  // Still in-progress (not timed out — those were reset before this loop)
  if (item.commitStatus === "IN_PROGRESS") {
    return {
      kind: "failed",
      uploadItemId,
      reason: "COMMIT_IN_PROGRESS",
      message: "Commit already in progress for this item",
    };
  }

  // --- SKIPPED duplicate handling ---
  if (item.duplicateStatus === "SKIPPED") {
    if (!item.duplicateImageId) {
      return {
        kind: "invalid",
        uploadItemId,
        reason: "SKIPPED_WITHOUT_DUPLICATE_IMAGE_ID",
        message: "Item is SKIPPED but has no duplicateImageId",
      };
    }
    await prisma.uploadItem.update({
      where: { id: uploadItemId },
      data: {
        commitStatus: "COMMITTED",
        committedImageId: item.duplicateImageId,
        committedAt: new Date(),
        commitError: null,
      },
    });
    await cleanupTempFiles(item);
    return { kind: "skipped", uploadItemId, imageId: item.duplicateImageId };
  }

  // --- Validation ---
  if (item.uploadStatus !== "READY") {
    return {
      kind: "invalid",
      uploadItemId,
      reason: "UPLOAD_NOT_READY",
      message: `uploadStatus is ${item.uploadStatus}, expected READY`,
    };
  }

  if (item.duplicateStatus === "DUPLICATE") {
    return {
      kind: "invalid",
      uploadItemId,
      reason: "DUPLICATE_UNRESOLVED",
      message: "Item is marked as DUPLICATE. Skip it or resolve before committing.",
    };
  }

  if (item.duplicateStatus === "UNCHECKED") {
    return {
      kind: "invalid",
      uploadItemId,
      reason: "DUPLICATE_UNCHECKED",
      message: "Run check-duplicates before committing",
    };
  }

  if (item.promptStatus !== "FILLED") {
    return {
      kind: "invalid",
      uploadItemId,
      reason: "PROMPT_NOT_FILLED",
      message: `promptStatus is ${item.promptStatus}, expected FILLED`,
    };
  }

  const promptDraft = (item.promptDraft ?? "").trim();
  if (!promptDraft) {
    return {
      kind: "invalid",
      uploadItemId,
      reason: "PROMPT_EMPTY",
      message: "promptDraft is empty",
    };
  }

  if (item.commitStatus !== "PENDING" && item.commitStatus !== "FAILED") {
    return {
      kind: "invalid",
      uploadItemId,
      reason: "INVALID_COMMIT_STATUS",
      message: `commitStatus is ${item.commitStatus}, expected PENDING or FAILED`,
    };
  }

  // --- Pre-commit duplicate re-check ---
  const existingImage = await prisma.image.findFirst({
    where: {
      workspaceId,
      fileHash: item.fileHash,
      deletedAt: null,
      status: { not: "DELETED" },
      ...(item.reservedImageId ? { id: { not: item.reservedImageId } } : {}),
    },
    select: { id: true },
  });

  if (existingImage) {
    await prisma.uploadItem.update({
      where: { id: uploadItemId },
      data: {
        duplicateStatus: "DUPLICATE",
        duplicateImageId: existingImage.id,
        commitStatus: "PENDING",
      },
    });
    return {
      kind: "invalid",
      uploadItemId,
      reason: "DUPLICATE_DETECTED_AT_COMMIT",
      message: `A duplicate image was found at commit time: ${existingImage.id}`,
    };
  }

  // --- Prepare reservedImageId and asset paths ---
  let reservedImageId = item.reservedImageId;
  let assetStoragePath = item.assetStoragePath;
  let assetThumbnailPath = item.assetThumbnailPath;
  let assetPreviewPath = item.assetPreviewPath;

  if (!reservedImageId) {
    reservedImageId = generateId();
    assetStoragePath = `${workspaceId}/assets/${reservedImageId}/original.${item.originalExt}`;
    assetThumbnailPath = item.tempThumbnailPath
      ? `${workspaceId}/assets/${reservedImageId}/thumbnail.webp`
      : null;
    assetPreviewPath = item.tempPreviewPath
      ? `${workspaceId}/assets/${reservedImageId}/preview.webp`
      : null;
  }

  // Mark as IN_PROGRESS and persist paths
  await prisma.uploadItem.update({
    where: { id: uploadItemId },
    data: {
      reservedImageId,
      assetStoragePath,
      assetThumbnailPath,
      assetPreviewPath,
      commitStatus: "IN_PROGRESS",
      commitStartedAt: new Date(),
      commitError: null,
    },
  });

  // --- Storage copy: original (required) ---
  const origResult = await copyStorageFile(item.tempStoragePath, assetStoragePath!);
  if (!origResult.ok) {
    await prisma.uploadItem.update({
      where: { id: uploadItemId },
      data: {
        commitStatus: "FAILED",
        commitError: `Original copy failed: ${origResult.message}`,
      },
    });
    return {
      kind: "failed",
      uploadItemId,
      reason: "STORAGE_COPY_FAILED",
      message: origResult.message,
    };
  }

  // --- Storage copy: thumbnail / preview (optional) ---
  let finalThumbnailPath: string | null = assetThumbnailPath;
  let finalPreviewPath: string | null = assetPreviewPath;

  const [thumbResult, prevResult] = await Promise.all([
    assetThumbnailPath && item.tempThumbnailPath
      ? copyStorageFile(item.tempThumbnailPath, assetThumbnailPath)
      : Promise.resolve({ ok: true } as const),
    assetPreviewPath && item.tempPreviewPath
      ? copyStorageFile(item.tempPreviewPath, assetPreviewPath)
      : Promise.resolve({ ok: true } as const),
  ]);

  if (!thumbResult.ok) finalThumbnailPath = null;
  if (!prevResult.ok) finalPreviewPath = null;

  // Persist corrected thumbnail/preview paths if copies partially failed
  if (finalThumbnailPath !== assetThumbnailPath || finalPreviewPath !== assetPreviewPath) {
    await prisma.uploadItem.update({
      where: { id: uploadItemId },
      data: {
        assetThumbnailPath: finalThumbnailPath,
        assetPreviewPath: finalPreviewPath,
      },
    });
  }

  // --- Build search text ---
  const searchText = buildImageSearchText({
    originalName: item.originalName,
    promptDraft,
    sceneName: item.scene?.name,
    tagNames: item.tags.map((t) => t.tag.name),
    personNames: item.persons.map((p) => p.person.name),
    notes: item.notes,
  });

  // --- DB Transaction ---
  try {
    const now = new Date();

    await prisma.$transaction(async (tx) => {
      // 1. Upsert image
      await tx.image.upsert({
        where: { id: reservedImageId! },
        create: {
          id: reservedImageId!,
          workspaceId,
          sceneId: item.sceneId,
          status: "ACTIVE",
          storageBucket: "photobox-private",
          storagePath: assetStoragePath!,
          thumbnailPath: finalThumbnailPath,
          previewPath: finalPreviewPath,
          originalName: item.originalName,
          originalExt: item.originalExt,
          mimeType: item.mimeType,
          fileSizeBytes: item.fileSizeBytes,
          widthPx: item.widthPx,
          heightPx: item.heightPx,
          fileHash: item.fileHash,
          rating: item.rating,
          isFavorite: item.isFavorite,
          notes: item.notes,
          searchText,
          uploadItemId: item.id,
        },
        update: {
          updatedAt: now,
        },
      });

      // 2. Upsert prompt
      await tx.prompt.upsert({
        where: { imageId: reservedImageId! },
        create: {
          workspaceId,
          imageId: reservedImageId!,
          originalBody: promptDraft,
          currentBody: promptDraft,
        },
        update: {
          updatedAt: now,
        },
      });

      // 3. image_tags from upload_item_tags
      if (item.tags.length > 0) {
        await tx.imageTag.createMany({
          data: item.tags.map((t) => ({
            imageId: reservedImageId!,
            tagId: t.tag.id,
            workspaceId,
          })),
          skipDuplicates: true,
        });
      }

      // 4. image_persons from upload_item_persons
      if (item.persons.length > 0) {
        await tx.imagePerson.createMany({
          data: item.persons.map((p) => ({
            imageId: reservedImageId!,
            personId: p.person.id,
            workspaceId,
          })),
          skipDuplicates: true,
        });
      }

      // 5. Mark upload item as committed
      await tx.uploadItem.update({
        where: { id: uploadItemId },
        data: {
          commitStatus: "COMMITTED",
          committedAt: now,
          committedImageId: reservedImageId!,
          commitError: null,
          assetThumbnailPath: finalThumbnailPath,
          assetPreviewPath: finalPreviewPath,
        },
      });
    });

    // Cleanup temp files (best-effort, non-fatal)
    await cleanupTempFiles(item);

    return { kind: "committed", uploadItemId, imageId: reservedImageId! };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown transaction error";
    await prisma.uploadItem
      .update({
        where: { id: uploadItemId },
        data: { commitStatus: "FAILED", commitError: message },
      })
      .catch(() => undefined);
    return {
      kind: "failed",
      uploadItemId,
      reason: "TRANSACTION_FAILED",
      message,
    };
  }
}

async function cleanupTempFiles(item: CommitItem): Promise<void> {
  const paths: string[] = [];
  if (item.tempStoragePath) paths.push(item.tempStoragePath);
  if (item.tempThumbnailPath) paths.push(item.tempThumbnailPath);
  if (item.tempPreviewPath) paths.push(item.tempPreviewPath);
  if (paths.length === 0) return;
  try {
    await supabaseAdmin.storage.from("photobox-private").remove(paths);
  } catch {
    // cleanup failure is non-fatal
  }
}
