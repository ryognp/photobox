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

  const tag = await prisma.tag.findFirst({
    where: { id, workspaceId: workspace.id },
    select: { id: true, _count: { select: { imageTags: true } } },
  });
  if (!tag) return Errors.notFound("Tag not found");

  if (tag._count.imageTags > 0) {
    return Errors.validation(
      `このタグには ${tag._count.imageTags} 枚の画像が紐づいているため削除できません。統合を使ってください。`,
    );
  }

  await prisma.tag.delete({ where: { id } });
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

  const existing = await prisma.tag.findFirst({
    where: { id, workspaceId: workspace.id },
    select: { id: true },
  });
  if (!existing) return Errors.notFound("Tag not found");

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Errors.validation("Invalid JSON");
  }

  if (!("name" in body)) return Errors.validation("No fields to update");

  const trimmed = typeof body.name === "string" ? body.name.trim() : "";
  if (!trimmed) return Errors.validation("name cannot be empty");

  const conflict = await prisma.tag.findFirst({
    where: { workspaceId: workspace.id, name: trimmed, NOT: { id } },
    select: { id: true },
  });
  if (conflict) return Errors.conflict(`Tag "${trimmed}" already exists`);

  const tag = await prisma.tag.update({
    where: { id },
    data: { name: trimmed },
    select: { id: true, name: true, createdAt: true },
  });

  return ok(tag);
}
