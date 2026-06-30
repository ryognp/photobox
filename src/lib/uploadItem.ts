import "server-only";

import { prisma } from "./prisma";
import type { PromptStatus } from "@/generated/prisma/enums";

// items 返却時の共通 select
export const ITEM_WITH_RELATIONS_SELECT = {
  id: true,
  sessionId: true,
  workspaceId: true,
  sortOrder: true,
  originalName: true,
  originalExt: true,
  mimeType: true,
  fileSizeBytes: true,
  widthPx: true,
  heightPx: true,
  fileHash: true,
  tempStoragePath: true,
  tempThumbnailPath: true,
  tempPreviewPath: true,
  uploadStatus: true,
  promptStatus: true,
  promptDraft: true,
  duplicateStatus: true,
  duplicateImageId: true,
  commitStatus: true,
  sceneId: true,
  rating: true,
  isFavorite: true,
  notes: true,
  committedImageId: true,
  createdAt: true,
  updatedAt: true,
  scene: { select: { id: true, name: true } },
  tags: { select: { tag: { select: { id: true, name: true } } } },
  persons: { select: { person: { select: { id: true, name: true } } } },
} as const;

type SessionSnap = {
  id: string;
  workspaceId: string;
  userId: string;
  status: string;
};

type ItemSnap = {
  id: string;
  workspaceId: string;
  commitStatus: string;
  session: SessionSnap;
};

// item 取得 + userId 認可チェック（workspace_members + session.userId）
export async function authorizeUploadItem(
  itemId: string,
  userId: string,
): Promise<
  | { ok: true; item: ItemSnap }
  | { ok: false; reason: "NOT_FOUND" | "FORBIDDEN" }
> {
  const item = await prisma.uploadItem.findUnique({
    where: { id: itemId },
    select: {
      id: true,
      workspaceId: true,
      commitStatus: true,
      session: {
        select: { id: true, workspaceId: true, userId: true, status: true },
      },
    },
  });

  if (!item) return { ok: false, reason: "NOT_FOUND" };
  if (item.session.userId !== userId) return { ok: false, reason: "FORBIDDEN" };

  const member = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: { workspaceId: item.workspaceId, userId },
    },
    select: { workspaceId: true },
  });
  if (!member) return { ok: false, reason: "FORBIDDEN" };

  return { ok: true, item };
}

// session.status が編集可能か確認
// ACTIVE / PREVIEWING のみ許可
export function assertSessionEditable(sessionStatus: string): string | null {
  if (sessionStatus === "ACTIVE" || sessionStatus === "PREVIEWING") return null;
  return `Session status is '${sessionStatus}'. Only ACTIVE or PREVIEWING sessions can be edited.`;
}

// commitStatus が COMMITTED なら編集不可
export function assertItemNotCommitted(commitStatus: string): string | null {
  if (commitStatus === "COMMITTED") return "This item is already committed and cannot be edited.";
  return null;
}

// promptDraft / saveMode から promptStatus を決定
export function normalizePromptStatus(
  promptDraft: string,
  saveMode: string,
): { status: PromptStatus; error: string | null } {
  if (saveMode === "draft") {
    return { status: promptDraft ? "DRAFT" : "EMPTY", error: null };
  }
  if (saveMode === "filled") {
    if (!promptDraft) return { status: "EMPTY", error: "promptDraft must not be empty when saveMode is 'filled'" };
    return { status: "FILLED", error: null };
  }
  return { status: "EMPTY", error: `saveMode must be 'draft' or 'filled', got '${saveMode}'` };
}

// item + relations を取得
export async function fetchItemWithRelations(itemId: string) {
  return prisma.uploadItem.findUnique({
    where: { id: itemId },
    select: ITEM_WITH_RELATIONS_SELECT,
  });
}
