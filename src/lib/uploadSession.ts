import "server-only";

import { prisma } from "./prisma";

// items の include 定義（GET / POST 共通）
export const ITEM_INCLUDE = {
  scene: { select: { id: true, name: true } },
  tags: {
    select: {
      tag: { select: { id: true, name: true } },
    },
  },
  persons: {
    select: {
      person: { select: { id: true, name: true } },
    },
  },
} as const;

// session の select 定義
export const SESSION_SELECT = {
  id: true,
  workspaceId: true,
  userId: true,
  status: true,
  title: true,
  createdAt: true,
  updatedAt: true,
  committedAt: true,
} as const;

// UploadItem の select 定義
export const ITEM_SELECT = {
  id: true,
  workspaceId: true,
  sessionId: true,
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
  duplicateStatus: true,
  commitStatus: true,
  duplicateImageId: true,
  promptDraft: true,
  sceneId: true,
  rating: true,
  isFavorite: true,
  notes: true,
  reservedImageId: true,
  committedImageId: true,
  commitError: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type SessionRow = {
  id: string;
  workspaceId: string;
  userId: string;
  status: string;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
  committedAt: Date | null;
};

// workspace_members で認可確認 + session の userId チェック
export async function authorizeSession(
  sessionId: string,
  userId: string,
): Promise<
  | { ok: true; session: SessionRow }
  | { ok: false; reason: "NOT_FOUND" | "FORBIDDEN" }
> {
  const session = await prisma.uploadSession.findUnique({
    where: { id: sessionId },
    select: SESSION_SELECT,
  });

  if (!session) return { ok: false, reason: "NOT_FOUND" };

  // 他ユーザーのセッションは 403
  if (session.userId !== userId) return { ok: false, reason: "FORBIDDEN" };

  // workspace membership 確認
  const member = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: { workspaceId: session.workspaceId, userId },
    },
    select: { workspaceId: true },
  });
  if (!member) return { ok: false, reason: "FORBIDDEN" };

  return { ok: true, session };
}

// session + items を整形して返す形式
export async function fetchSessionWithItems(sessionId: string) {
  const session = await prisma.uploadSession.findUnique({
    where: { id: sessionId },
    select: SESSION_SELECT,
  });
  if (!session) return null;

  const items = await prisma.uploadItem.findMany({
    where: { sessionId },
    orderBy: { sortOrder: "asc" },
    select: {
      ...ITEM_SELECT,
      scene: { select: { id: true, name: true } },
      tags: { select: { tag: { select: { id: true, name: true } } } },
      persons: { select: { person: { select: { id: true, name: true } } } },
    },
  });

  return { session, items };
}
