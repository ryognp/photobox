import { NextRequest } from "next/server";
import { getCurrentUser, getDefaultWorkspaceForUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, Errors } from "@/lib/apiResponse";
import { fetchSessionWithItems } from "@/lib/uploadSession";

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();

  const workspace = await getDefaultWorkspaceForUser(user.id);
  if (!workspace) return Errors.forbidden();

  // body は任意（title のみ受け付ける）
  let title: string | null = null;
  try {
    const body = await request.json().catch(() => ({}));
    const rawTitle = (body as Record<string, unknown>).title;
    if (typeof rawTitle === "string") {
      title = rawTitle.trim() || null;
    }
  } catch {
    // body なしは許容
  }

  // ACTIVE session が既にあれば再開して返す
  // NOTE: PREVIEWING は再開対象に含めない。
  //       PREVIEWING は Quick Add のプレビュー画面を経由した状態のため
  //       GET /api/uploads/session/:id で直接復元する。
  const existing = await prisma.uploadSession.findFirst({
    where: {
      workspaceId: workspace.id,
      userId: user.id,
      status: "ACTIVE",
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });

  if (existing) {
    const data = await fetchSessionWithItems(existing.id);
    if (!data) return Errors.internal();
    return ok(data);
  }

  // 新規作成
  const session = await prisma.uploadSession.create({
    data: {
      workspaceId: workspace.id,
      userId: user.id,
      status: "ACTIVE",
      title,
    },
    select: { id: true },
  });

  const data = await fetchSessionWithItems(session.id);
  if (!data) return Errors.internal();
  return ok(data, 201);
}
