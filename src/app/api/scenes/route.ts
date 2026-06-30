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

  const scenes = await prisma.scene.findMany({
    where: {
      workspaceId: workspace.id,
      ...(q ? { name: { contains: q, mode: "insensitive" } } : {}),
    },
    orderBy: { name: "asc" },
    select: {
      id: true, name: true, description: true, createdAt: true,
      _count: { select: { images: { where: { workspaceId: workspace.id, deletedAt: null, status: "ACTIVE" } } } },
    },
  });

  return ok(scenes.map((s) => ({ ...s, imageCount: s._count.images, _count: undefined })));
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

  const { name, description } = body as Record<string, unknown>;

  const trimmedName = typeof name === "string" ? name.trim() : "";
  if (!trimmedName) return Errors.validation("name is required");

  const trimmedDesc =
    typeof description === "string" ? description.trim() || null : null;

  // 同名が既存なら返す（upsert の代わりに findFirst → create）
  const existing = await prisma.scene.findFirst({
    where: { workspaceId: workspace.id, name: trimmedName },
    select: { id: true, name: true, description: true, createdAt: true },
  });
  if (existing) return ok(existing);

  const scene = await prisma.scene.create({
    data: { workspaceId: workspace.id, name: trimmedName, description: trimmedDesc },
    select: { id: true, name: true, description: true, createdAt: true },
  });

  return ok(scene, 201);
}
