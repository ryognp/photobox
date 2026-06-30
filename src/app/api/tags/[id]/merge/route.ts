import "server-only";

import { NextRequest } from "next/server";
import { getCurrentUser, getDefaultWorkspaceForUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, Errors } from "@/lib/apiResponse";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();

  const workspace = await getDefaultWorkspaceForUser(user.id);
  if (!workspace) return Errors.forbidden();

  const { id: sourceId } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Errors.validation("Invalid JSON");
  }

  const targetId = typeof body.targetId === "string" ? body.targetId.trim() : "";
  if (!targetId) return Errors.validation("targetId is required");
  if (sourceId === targetId) return Errors.validation("sourceId and targetId must be different");

  const dryRun = body.dryRun === true;

  const [source, target] = await Promise.all([
    prisma.tag.findFirst({
      where: { id: sourceId, workspaceId: workspace.id },
      select: { id: true, name: true },
    }),
    prisma.tag.findFirst({
      where: { id: targetId, workspaceId: workspace.id },
      select: { id: true, name: true },
    }),
  ]);

  if (!source) return Errors.notFound("Source tag not found");
  if (!target) return Errors.notFound("Target tag not found");

  // Gather linkage for safe duplicate-aware move
  const [
    sourceImageIds,
    targetImageIdSet,
    sourceUploadItemIds,
    targetUploadItemIdSet,
  ] = await Promise.all([
    prisma.imageTag
      .findMany({ where: { tagId: sourceId }, select: { imageId: true } })
      .then((r) => r.map((x) => x.imageId)),
    prisma.imageTag
      .findMany({ where: { tagId: targetId }, select: { imageId: true } })
      .then((r) => new Set(r.map((x) => x.imageId))),
    prisma.uploadItemTag
      .findMany({ where: { tagId: sourceId }, select: { uploadItemId: true } })
      .then((r) => r.map((x) => x.uploadItemId)),
    prisma.uploadItemTag
      .findMany({ where: { tagId: targetId }, select: { uploadItemId: true } })
      .then((r) => new Set(r.map((x) => x.uploadItemId))),
  ]);

  const duplicatesToSkip = sourceImageIds.filter((id) => targetImageIdSet.has(id)).length;
  const imagesToMove = sourceImageIds.length - duplicatesToSkip;
  const nonDuplicateImageIds = sourceImageIds.filter((id) => !targetImageIdSet.has(id));
  const nonDuplicateUploadItemIds = sourceUploadItemIds.filter(
    (id) => !targetUploadItemIdSet.has(id),
  );

  if (dryRun) {
    return ok({
      source,
      target,
      counts: {
        imagesToMove,
        duplicatesToSkip,
        uploadItemsToMove: nonDuplicateUploadItemIds.length,
      },
    });
  }

  // Execute merge using safe create+delete pattern for junction tables
  await prisma.$transaction(async (tx) => {
    // image_tags: create new rows for target, then delete all source rows
    if (nonDuplicateImageIds.length > 0) {
      await tx.imageTag.createMany({
        data: nonDuplicateImageIds.map((imageId) => ({
          imageId,
          tagId: targetId,
          workspaceId: workspace.id,
        })),
        skipDuplicates: true,
      });
    }
    await tx.imageTag.deleteMany({ where: { tagId: sourceId } });

    // upload_item_tags: same pattern
    if (nonDuplicateUploadItemIds.length > 0) {
      await tx.uploadItemTag.createMany({
        data: nonDuplicateUploadItemIds.map((uploadItemId) => ({
          uploadItemId,
          tagId: targetId,
          workspaceId: workspace.id,
        })),
        skipDuplicates: true,
      });
    }
    await tx.uploadItemTag.deleteMany({ where: { tagId: sourceId } });

    // Delete source tag
    await tx.tag.delete({ where: { id: sourceId } });
  });

  return ok({
    merged: true,
    source,
    target,
    counts: { imagesToMove, duplicatesToSkip, uploadItemsToMove: nonDuplicateUploadItemIds.length },
  });
}
