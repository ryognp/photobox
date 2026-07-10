import "server-only";

import { prisma } from "./prisma";
import { resolveSignedUrls, type BatchRequest } from "./signedUrl";
import { attachThumbnailSignedUrls } from "./uploadSessionThumbnails";

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

// session + items を整形して返す形式。
// userId を渡した場合のみ、各 item に private-bucket thumbnail の signed URL
// (`signedUrls.thumbnail`) を付与する（Quick Add commit プレビューの画像表示用）。
// userId は呼び出し元が既に session の所有者 / workspace membership を確認済み
// のものを渡すこと — resolveSignedUrls 内部でも workspace membership を
// 再チェックするため、service role で無条件に signed URL を発行することはない。
// raw storage path (tempThumbnailPath 等) は ITEM_SELECT に残るが、UI 側では
// signedUrls のみを画像表示に使う。
export async function fetchSessionWithItems(sessionId: string, userId?: string) {
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

  if (!userId) return { session, items };

  const requests: BatchRequest[] = items.map((item, index) => ({
    index,
    type: "uploadItem",
    id: item.id,
    variant: "thumbnail",
  }));
  const { results } = await resolveSignedUrls(requests, userId);

  return { session, items: attachThumbnailSignedUrls(items, results) };
}
