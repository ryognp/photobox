import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, Errors } from "@/lib/apiResponse";
import { assertSessionEditable, ITEM_WITH_RELATIONS_SELECT } from "@/lib/uploadItem";

const MAX_ITEMS = 100;

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Errors.validation("Invalid JSON");
  }

  const { sessionId, itemIds, promptDraft: rawPromptDraft } = body;

  // sessionId
  if (typeof sessionId !== "string" || !sessionId) {
    return Errors.validation("sessionId is required");
  }

  // promptDraft
  if (typeof rawPromptDraft !== "string") {
    return Errors.validation("promptDraft must be a string");
  }
  const promptDraft = rawPromptDraft.trim();
  if (!promptDraft) return Errors.validation("promptDraft must not be empty");

  // itemIds
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    return Errors.validation("itemIds must be a non-empty array");
  }
  if (itemIds.length > MAX_ITEMS) {
    return Errors.validation(`itemIds must not exceed ${MAX_ITEMS} items`);
  }
  const uniqueItemIds = [...new Set(itemIds.filter((v): v is string => typeof v === "string"))];

  // session 取得 + 認可
  const session = await prisma.uploadSession.findUnique({
    where: { id: sessionId },
    select: { id: true, workspaceId: true, userId: true, status: true },
  });
  if (!session) return Errors.notFound("Session not found");
  if (session.userId !== user.id) return Errors.forbidden();

  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: session.workspaceId, userId: user.id } },
    select: { workspaceId: true },
  });
  if (!member) return Errors.forbidden();

  const sessionErr = assertSessionEditable(session.status);
  if (sessionErr) return Errors.validation(sessionErr);

  // itemIds がすべて同じ session / workspace に属しているか確認
  const items = await prisma.uploadItem.findMany({
    where: {
      id: { in: uniqueItemIds },
      sessionId: session.id,
      workspaceId: session.workspaceId,
    },
    select: { id: true, uploadStatus: true, commitStatus: true },
  });

  if (items.length !== uniqueItemIds.length) {
    return Errors.validation("Some itemIds not found in this session or workspace");
  }

  // commitStatus = COMMITTED の item は除外して更新（READY のみ対象）
  const targetIds = items
    .filter((it) => it.commitStatus !== "COMMITTED" && it.uploadStatus === "READY")
    .map((it) => it.id);

  if (targetIds.length === 0) {
    return Errors.validation("No eligible items to update (items must be READY and not COMMITTED)");
  }

  await prisma.uploadItem.updateMany({
    where: { id: { in: targetIds } },
    data: { promptDraft, promptStatus: "FILLED" },
  });

  const updatedItems = await prisma.uploadItem.findMany({
    where: { id: { in: targetIds } },
    orderBy: { sortOrder: "asc" },
    select: ITEM_WITH_RELATIONS_SELECT,
  });

  return ok({ updatedCount: updatedItems.length, items: updatedItems });
}
