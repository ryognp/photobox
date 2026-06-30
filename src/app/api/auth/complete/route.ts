import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";

export async function POST() {
  let user;
  try {
    user = await requireUser();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 既に workspace があれば何もしない（冪等）
  const existing = await prisma.workspaceMember.findFirst({
    where: { userId: user.id },
    select: { workspaceId: true },
  });
  if (existing) {
    return NextResponse.json({ workspaceId: existing.workspaceId });
  }

  // personal workspace を作成
  const baseSlug = `ws-${user.id.slice(0, 8)}`;
  const slug = await resolveUniqueSlug(baseSlug);

  const workspace = await prisma.$transaction(async (tx) => {
    const ws = await tx.workspace.create({
      data: {
        name: "My Workspace",
        slug,
      },
    });
    await tx.workspaceMember.create({
      data: {
        workspaceId: ws.id,
        userId: user.id,
        role: "owner",
      },
    });
    return ws;
  });

  return NextResponse.json({ workspaceId: workspace.id }, { status: 201 });
}

async function resolveUniqueSlug(base: string): Promise<string> {
  const exists = await prisma.workspace.findUnique({ where: { slug: base }, select: { id: true } });
  if (!exists) return base;

  for (let i = 2; i <= 99; i++) {
    const candidate = `${base}-${i}`;
    const dup = await prisma.workspace.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!dup) return candidate;
  }
  // fallback: timestamp suffix
  return `${base}-${Date.now()}`;
}
