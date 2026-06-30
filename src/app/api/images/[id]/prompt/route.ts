import "server-only";

import { NextRequest } from "next/server";
import { getCurrentUser, getDefaultWorkspaceForUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, Errors } from "@/lib/apiResponse";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();

  const workspace = await getDefaultWorkspaceForUser(user.id);
  if (!workspace) return Errors.forbidden();

  const { id: imageId } = await params;

  // Find image + prompt
  const image = await prisma.image.findFirst({
    where: {
      id: imageId,
      workspaceId: workspace.id,
      deletedAt: null,
      status: { not: "DELETED" },
    },
    select: {
      id: true,
      workspaceId: true,
      prompt: {
        select: {
          id: true,
          originalBody: true,
          currentBody: true,
          versions: {
            select: {
              id: true,
              versionType: true,
              body: true,
              changeNote: true,
              createdAt: true,
              scene: { select: { id: true, name: true } },
            },
            orderBy: { createdAt: "desc" },
          },
        },
      },
    },
  });

  if (!image) return Errors.notFound("Image not found");
  if (!image.prompt) return Errors.notFound("Prompt not found for this image");

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Errors.validation("Invalid JSON");
  }

  if (typeof body.currentBody !== "string") {
    return Errors.validation("currentBody is required");
  }
  const newBody = body.currentBody.trim();
  if (!newBody) return Errors.validation("currentBody cannot be empty");

  const changeNote =
    typeof body.changeNote === "string" && body.changeNote.trim()
      ? body.changeNote.trim()
      : "Manual prompt edit";

  // No-op if same
  if (newBody === image.prompt.currentBody) {
    return ok({
      prompt: {
        id: image.prompt.id,
        originalBody: image.prompt.originalBody,
        currentBody: image.prompt.currentBody,
        versions: image.prompt.versions,
      },
      image: { id: image.id, searchText: null },
    });
  }

  // Build new searchText
  const searchText = newBody;

  // Transactionally create version + update prompt + update image searchText
  const [updatedPrompt] = await prisma.$transaction([
    prisma.prompt.update({
      where: { id: image.prompt.id },
      data: {
        currentBody: newBody,
        versions: {
          create: {
            workspaceId: workspace.id,
            versionType: "EDIT",
            body: newBody,
            changeNote,
          },
        },
      },
      select: {
        id: true,
        originalBody: true,
        currentBody: true,
        versions: {
          select: {
            id: true,
            versionType: true,
            body: true,
            changeNote: true,
            createdAt: true,
            scene: { select: { id: true, name: true } },
          },
          orderBy: { createdAt: "desc" },
        },
      },
    }),
    prisma.image.update({
      where: { id: image.id },
      data: { searchText },
    }),
  ]);

  return ok({
    prompt: updatedPrompt,
    image: { id: image.id, searchText },
  });
}
