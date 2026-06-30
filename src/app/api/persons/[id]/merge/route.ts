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
    prisma.person.findFirst({
      where: { id: sourceId, workspaceId: workspace.id },
      select: { id: true, name: true },
    }),
    prisma.person.findFirst({
      where: { id: targetId, workspaceId: workspace.id },
      select: { id: true, name: true },
    }),
  ]);

  if (!source) return Errors.notFound("Source person not found");
  if (!target) return Errors.notFound("Target person not found");

  // Gather source/target linkage to compute move/skip counts
  const [
    sourceImageIds,
    targetImageIdSet,
    sourceUploadItemIds,
    targetUploadItemIdSet,
    promptGroupsToMove,
  ] = await Promise.all([
    prisma.imagePerson
      .findMany({ where: { personId: sourceId }, select: { imageId: true } })
      .then((r) => r.map((x) => x.imageId)),
    prisma.imagePerson
      .findMany({ where: { personId: targetId }, select: { imageId: true } })
      .then((r) => new Set(r.map((x) => x.imageId))),
    prisma.uploadItemPerson
      .findMany({ where: { personId: sourceId }, select: { uploadItemId: true } })
      .then((r) => r.map((x) => x.uploadItemId)),
    prisma.uploadItemPerson
      .findMany({ where: { personId: targetId }, select: { uploadItemId: true } })
      .then((r) => new Set(r.map((x) => x.uploadItemId))),
    prisma.promptGroup.count({ where: { personId: sourceId } }),
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
        promptGroupsToMove,
      },
    });
  }

  // Execute merge in transaction using safe create+delete pattern for junction tables
  await prisma.$transaction(async (tx) => {
    // image_persons: create new rows for target, then delete all source rows
    if (nonDuplicateImageIds.length > 0) {
      await tx.imagePerson.createMany({
        data: nonDuplicateImageIds.map((imageId) => ({
          imageId,
          personId: targetId,
          workspaceId: workspace.id,
        })),
        skipDuplicates: true,
      });
    }
    await tx.imagePerson.deleteMany({ where: { personId: sourceId } });

    // upload_item_persons: same pattern
    if (nonDuplicateUploadItemIds.length > 0) {
      await tx.uploadItemPerson.createMany({
        data: nonDuplicateUploadItemIds.map((uploadItemId) => ({
          uploadItemId,
          personId: targetId,
          workspaceId: workspace.id,
        })),
        skipDuplicates: true,
      });
    }
    await tx.uploadItemPerson.deleteMany({ where: { personId: sourceId } });

    // prompt_groups: simple FK update (no composite PK conflict risk)
    await tx.promptGroup.updateMany({
      where: { personId: sourceId },
      data: { personId: targetId },
    });

    // Delete source person
    await tx.person.delete({ where: { id: sourceId } });
  });

  return ok({
    merged: true,
    source,
    target,
    counts: {
      imagesToMove,
      duplicatesToSkip,
      uploadItemsToMove: nonDuplicateUploadItemIds.length,
      promptGroupsToMove,
    },
  });
}
