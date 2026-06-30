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
    prisma.scene.findFirst({
      where: { id: sourceId, workspaceId: workspace.id },
      select: { id: true, name: true },
    }),
    prisma.scene.findFirst({
      where: { id: targetId, workspaceId: workspace.id },
      select: { id: true, name: true },
    }),
  ]);

  if (!source) return Errors.notFound("Source scene not found");
  if (!target) return Errors.notFound("Target scene not found");

  const [imagesToMove, uploadItemsToMove, promptVersionsToMove, promptGroupsToMove] =
    await Promise.all([
      prisma.image.count({ where: { sceneId: sourceId } }),
      prisma.uploadItem.count({ where: { sceneId: sourceId } }),
      prisma.promptVersion.count({ where: { sceneId: sourceId } }),
      prisma.promptGroup.count({ where: { sceneId: sourceId } }),
    ]);

  if (dryRun) {
    return ok({
      source,
      target,
      counts: { imagesToMove, duplicatesToSkip: 0, uploadItemsToMove, promptVersionsToMove, promptGroupsToMove },
    });
  }

  await prisma.$transaction(async (tx) => {
    await tx.image.updateMany({ where: { sceneId: sourceId }, data: { sceneId: targetId } });
    await tx.uploadItem.updateMany({ where: { sceneId: sourceId }, data: { sceneId: targetId } });
    await tx.promptVersion.updateMany({ where: { sceneId: sourceId }, data: { sceneId: targetId } });
    await tx.promptGroup.updateMany({ where: { sceneId: sourceId }, data: { sceneId: targetId } });
    await tx.scene.delete({ where: { id: sourceId } });
  });

  return ok({ merged: true, source, target, counts: { imagesToMove, duplicatesToSkip: 0, uploadItemsToMove, promptVersionsToMove, promptGroupsToMove } });
}
