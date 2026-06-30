import "server-only";

import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, Errors } from "@/lib/apiResponse";
import { ITEM_WITH_RELATIONS_SELECT } from "@/lib/uploadItem";

export async function POST(req: NextRequest) {
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

  const session = await prisma.uploadSession.findUnique({
    where: { id: sessionId },
    select: { id: true, workspaceId: true, userId: true, status: true },
  });

  if (!session) return Errors.notFound("Session not found");
  if (session.userId !== user.id) return Errors.forbidden();

  const member = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: { workspaceId: session.workspaceId, userId: user.id },
    },
  });
  if (!member) return Errors.forbidden();

  if (session.status !== "ACTIVE" && session.status !== "PREVIEWING") {
    return Errors.validation("Session is not editable");
  }

  let itemIds: string[] | null = null;
  if (rawItemIds !== undefined && rawItemIds !== null) {
    if (
      !Array.isArray(rawItemIds) ||
      rawItemIds.length === 0 ||
      !rawItemIds.every((id) => typeof id === "string")
    ) {
      return Errors.validation("itemIds must be a non-empty array of strings");
    }
    itemIds = rawItemIds as string[];
  }

  const eligibleItems = await prisma.uploadItem.findMany({
    where: {
      sessionId: session.id,
      workspaceId: session.workspaceId,
      uploadStatus: "READY",
      commitStatus: { in: ["PENDING", "FAILED"] },
      duplicateStatus: { not: "SKIPPED" },
      ...(itemIds ? { id: { in: itemIds } } : {}),
    },
    select: { id: true, fileHash: true },
  });

  if (itemIds && eligibleItems.length !== itemIds.length) {
    return Errors.validation(
      "Some itemIds were not found or are not eligible for duplicate checking",
    );
  }

  const duplicateIds: string[] = [];
  const duplicateImageIds: Record<string, string> = {};
  const cleanIds: string[] = [];

  for (const item of eligibleItems) {
    const image = await prisma.image.findFirst({
      where: {
        workspaceId: session.workspaceId,
        fileHash: item.fileHash,
        deletedAt: null,
        status: { not: "DELETED" },
      },
      select: { id: true },
    });

    if (image) {
      duplicateIds.push(item.id);
      duplicateImageIds[item.id] = image.id;
    } else {
      cleanIds.push(item.id);
    }
  }

  await prisma.$transaction([
    ...(duplicateIds.length > 0
      ? duplicateIds.map((id) =>
          prisma.uploadItem.update({
            where: { id },
            data: { duplicateStatus: "DUPLICATE", duplicateImageId: duplicateImageIds[id] },
          }),
        )
      : []),
    ...(cleanIds.length > 0
      ? [
          prisma.uploadItem.updateMany({
            where: { id: { in: cleanIds } },
            data: { duplicateStatus: "CLEAN", duplicateImageId: null },
          }),
        ]
      : []),
  ]);

  const totalInSession = await prisma.uploadItem.count({
    where: {
      sessionId: session.id,
      workspaceId: session.workspaceId,
    },
  });

  const skippedCount = await prisma.uploadItem.count({
    where: {
      sessionId: session.id,
      workspaceId: session.workspaceId,
      duplicateStatus: "SKIPPED",
    },
  });

  const checkedCount = eligibleItems.length;
  const ignoredCount = totalInSession - checkedCount - skippedCount;

  const updatedItems = await prisma.uploadItem.findMany({
    where: {
      id: { in: eligibleItems.map((i) => i.id) },
    },
    select: ITEM_WITH_RELATIONS_SELECT,
  });

  return ok({
    summary: {
      checked: checkedCount,
      clean: cleanIds.length,
      duplicates: duplicateIds.length,
      skipped: skippedCount,
      ignored: ignoredCount < 0 ? 0 : ignoredCount,
    },
    items: updatedItems,
  });
}
