import "server-only";

import { NextRequest } from "next/server";
import { getCurrentUser, getDefaultWorkspaceForUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, Errors } from "@/lib/apiResponse";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();

  const workspace = await getDefaultWorkspaceForUser(user.id);
  if (!workspace) return Errors.forbidden();

  const { id } = await params;

  const scene = await prisma.scene.findFirst({
    where: { id, workspaceId: workspace.id },
    select: { id: true, _count: { select: { images: true } } },
  });
  if (!scene) return Errors.notFound("Scene not found");

  if (scene._count.images > 0) {
    return Errors.validation(
      `このシーンには ${scene._count.images} 枚の画像が紐づいているため削除できません。統合を使ってください。`,
    );
  }

  await prisma.scene.delete({ where: { id } });
  return ok({ deleted: true });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();

  const workspace = await getDefaultWorkspaceForUser(user.id);
  if (!workspace) return Errors.forbidden();

  const { id } = await params;

  const existing = await prisma.scene.findFirst({
    where: { id, workspaceId: workspace.id },
    select: { id: true },
  });
  if (!existing) return Errors.notFound("Scene not found");

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Errors.validation("Invalid JSON");
  }

  const data: Record<string, unknown> = {};
  if ("name" in body) {
    const trimmed = typeof body.name === "string" ? body.name.trim() : "";
    if (!trimmed) return Errors.validation("name cannot be empty");
    data.name = trimmed;
  }
  if ("description" in body) {
    data.description =
      typeof body.description === "string" ? body.description.trim() || null : null;
  }

  if (Object.keys(data).length === 0) return Errors.validation("No fields to update");

  if (data.name !== undefined) {
    const conflict = await prisma.scene.findFirst({
      where: { workspaceId: workspace.id, name: data.name as string, NOT: { id } },
      select: { id: true },
    });
    if (conflict) return Errors.conflict(`Scene "${data.name as string}" already exists`);
  }

  const scene = await prisma.scene.update({
    where: { id },
    data,
    select: { id: true, name: true, description: true, createdAt: true },
  });

  return ok(scene);
}
