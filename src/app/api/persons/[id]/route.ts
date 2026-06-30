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

  const person = await prisma.person.findFirst({
    where: { id, workspaceId: workspace.id },
    select: { id: true, _count: { select: { imagePersons: true } } },
  });
  if (!person) return Errors.notFound("Person not found");

  if (person._count.imagePersons > 0) {
    return Errors.validation(
      `この人物には ${person._count.imagePersons} 枚の画像が紐づいているため削除できません。統合を使ってください。`,
    );
  }

  await prisma.person.delete({ where: { id } });
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

  const existing = await prisma.person.findFirst({
    where: { id, workspaceId: workspace.id },
    select: { id: true },
  });
  if (!existing) return Errors.notFound("Person not found");

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
  if ("notes" in body) {
    data.notes = typeof body.notes === "string" ? body.notes.trim() || null : null;
  }
  if ("defaultPromptHint" in body) {
    data.defaultPromptHint =
      typeof body.defaultPromptHint === "string" ? body.defaultPromptHint.trim() || null : null;
  }

  if (Object.keys(data).length === 0) return Errors.validation("No fields to update");

  if (data.name !== undefined) {
    const conflict = await prisma.person.findFirst({
      where: { workspaceId: workspace.id, name: data.name as string, NOT: { id } },
      select: { id: true },
    });
    if (conflict) return Errors.conflict(`Person "${data.name as string}" already exists`);
  }

  const person = await prisma.person.update({
    where: { id },
    data,
    select: { id: true, name: true, notes: true, defaultPromptHint: true, createdAt: true },
  });

  return ok(person);
}
