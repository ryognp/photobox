import { NextRequest } from "next/server";
import { getCurrentUser, getDefaultWorkspaceForUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, Errors } from "@/lib/apiResponse";

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();

  const workspace = await getDefaultWorkspaceForUser(user.id);
  if (!workspace) return Errors.forbidden();

  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";

  const tags = await prisma.tag.findMany({
    where: {
      workspaceId: workspace.id,
      ...(q ? { name: { contains: q, mode: "insensitive" } } : {}),
    },
    orderBy: { name: "asc" },
    select: {
      id: true, name: true, createdAt: true,
      _count: { select: { imageTags: { where: { image: { workspaceId: workspace.id, deletedAt: null, status: "ACTIVE" } } } } },
    },
  });

  return ok(tags.map((t) => ({ ...t, imageCount: t._count.imageTags, _count: undefined })));
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();

  const workspace = await getDefaultWorkspaceForUser(user.id);
  if (!workspace) return Errors.forbidden();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Errors.validation("Invalid JSON");
  }

  const { name } = body as Record<string, unknown>;

  const trimmedName = typeof name === "string" ? name.trim() : "";
  if (!trimmedName) return Errors.validation("name is required");

  const existing = await prisma.tag.findFirst({
    where: { workspaceId: workspace.id, name: trimmedName },
    select: { id: true, name: true, createdAt: true },
  });
  if (existing) return ok(existing);

  const tag = await prisma.tag.create({
    data: { workspaceId: workspace.id, name: trimmedName },
    select: { id: true, name: true, createdAt: true },
  });

  return ok(tag, 201);
}
