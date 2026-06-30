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

  const persons = await prisma.person.findMany({
    where: {
      workspaceId: workspace.id,
      ...(q ? { name: { contains: q, mode: "insensitive" } } : {}),
    },
    orderBy: { name: "asc" },
    select: {
      id: true, name: true, notes: true, defaultPromptHint: true, createdAt: true,
      _count: { select: { imagePersons: { where: { image: { workspaceId: workspace.id, deletedAt: null, status: "ACTIVE" } } } } },
    },
  });

  return ok(persons.map((p) => ({ ...p, imageCount: p._count.imagePersons, _count: undefined })));
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

  const { name, notes, defaultPromptHint } = body as Record<string, unknown>;

  const trimmedName = typeof name === "string" ? name.trim() : "";
  if (!trimmedName) return Errors.validation("name is required");

  const trimmedNotes =
    typeof notes === "string" ? notes.trim() || null : null;
  const trimmedHint =
    typeof defaultPromptHint === "string" ? defaultPromptHint.trim() || null : null;

  const existing = await prisma.person.findFirst({
    where: { workspaceId: workspace.id, name: trimmedName },
    select: { id: true, name: true, notes: true, defaultPromptHint: true, createdAt: true },
  });
  if (existing) return ok(existing);

  const person = await prisma.person.create({
    data: {
      workspaceId: workspace.id,
      name: trimmedName,
      notes: trimmedNotes,
      defaultPromptHint: trimmedHint,
    },
    select: { id: true, name: true, notes: true, defaultPromptHint: true, createdAt: true },
  });

  return ok(person, 201);
}
