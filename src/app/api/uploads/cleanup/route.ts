import "server-only";

import { NextRequest } from "next/server";
import { getCurrentUser, getDefaultWorkspaceForUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { ok, Errors } from "@/lib/apiResponse";

const BUCKET = "photobox-private";
const MAX_SESSIONS = 50;
const DEFAULT_HOURS = 24;
const MIN_HOURS = 1;
const MAX_HOURS = 168;

// Cleanup 方針:
// - COMMITTED session / COMMITTED item は絶対に削除しない
// - temp Storage ファイルを先に削除し、次に DB レコードを物理削除する
// - Storage 削除失敗は警告として記録し処理継続

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();

  const workspace = await getDefaultWorkspaceForUser(user.id);
  if (!workspace) return Errors.forbidden();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const raw = body as Record<string, unknown>;
  const olderThanHoursRaw = raw.olderThanHours ?? DEFAULT_HOURS;
  const dryRun = raw.dryRun !== false; // default true

  if (typeof olderThanHoursRaw !== "number" || !Number.isFinite(olderThanHoursRaw)) {
    return Errors.validation("olderThanHours must be a number");
  }
  const olderThanHours = Math.floor(olderThanHoursRaw);
  if (olderThanHours < MIN_HOURS || olderThanHours > MAX_HOURS) {
    return Errors.validation(`olderThanHours must be between ${MIN_HOURS} and ${MAX_HOURS}`);
  }

  const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);

  // 対象 session を取得（COMMITTED 以外、現在ユーザーの workspace のみ）
  const sessions = await prisma.uploadSession.findMany({
    where: {
      workspaceId: workspace.id,
      userId: user.id,
      status: { in: ["ACTIVE", "PREVIEWING", "ABANDONED"] },
      createdAt: { lt: cutoff },
    },
    take: MAX_SESSIONS,
    select: {
      id: true,
      status: true,
      createdAt: true,
      items: {
        select: {
          id: true,
          commitStatus: true,
          tempStoragePath: true,
          tempThumbnailPath: true,
          tempPreviewPath: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  // 対象 item から temp paths を収集（COMMITTED item は除外）
  const allTempPaths: string[] = [];
  for (const session of sessions) {
    for (const item of session.items) {
      if (item.commitStatus === "COMMITTED") continue;
      if (item.tempStoragePath) allTempPaths.push(item.tempStoragePath);
      if (item.tempThumbnailPath) allTempPaths.push(item.tempThumbnailPath);
      if (item.tempPreviewPath) allTempPaths.push(item.tempPreviewPath);
    }
  }

  const totalItems = sessions.reduce((acc, s) => {
    return acc + s.items.filter((i) => i.commitStatus !== "COMMITTED").length;
  }, 0);

  const sessionSummary = sessions.map((s) => ({
    id: s.id,
    status: s.status,
    createdAt: s.createdAt,
    itemCount: s.items.filter((i) => i.commitStatus !== "COMMITTED").length,
  }));

  if (dryRun) {
    return ok({
      dryRun: true,
      olderThanHours,
      summary: {
        sessions: sessions.length,
        items: totalItems,
        storagePaths: allTempPaths.length,
        deletedStoragePaths: 0,
        warnings: 0,
      },
      sessions: sessionSummary,
      warnings: [],
    });
  }

  // --- 実行モード ---
  const warnings: string[] = [];
  let deletedStoragePaths = 0;

  // 1. Storage temp ファイルを削除（バッチ最大 1000 ファイルずつ）
  const BATCH = 1000;
  for (let i = 0; i < allTempPaths.length; i += BATCH) {
    const batch = allTempPaths.slice(i, i + BATCH);
    const { error } = await supabaseAdmin.storage.from(BUCKET).remove(batch);
    if (error) {
      warnings.push(`Storage remove error (batch ${Math.floor(i / BATCH) + 1}): ${error.message}`);
    } else {
      deletedStoragePaths += batch.length;
    }
  }

  // 2. DB: upload_sessions を物理削除（Cascade で upload_items, upload_item_tags, upload_item_persons も削除）
  const sessionIds = sessions.map((s) => s.id);
  try {
    await prisma.uploadSession.deleteMany({
      where: {
        id: { in: sessionIds },
        status: { not: "COMMITTED" }, // 安全弁: COMMITTED は絶対に消さない
      },
    });
  } catch (e: unknown) {
    warnings.push(`DB delete error: ${(e as Error).message}`);
  }

  return ok({
    dryRun: false,
    olderThanHours,
    summary: {
      sessions: sessions.length,
      items: totalItems,
      storagePaths: allTempPaths.length,
      deletedStoragePaths,
      warnings: warnings.length,
    },
    sessions: sessionSummary,
    warnings,
  });
}
