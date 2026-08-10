export const dynamic = "force-dynamic";
// Phase 10-43-B3c-2: 明示 export。IN_FLIGHT_GRACE_MS(60min) ≫ maxDuration を
// repo 内で証明可能にする(B3c-3 の stale UPLOADING 回収の前提)。
export const maxDuration = 60;

import { NextRequest } from "next/server";
import cuid from "cuid";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { err, ok, Errors } from "@/lib/apiResponse";
import { isLeaseActive } from "@/lib/upload/uploadIntentCore";
import { validateImageFile } from "@/lib/upload/validateImage";
import { sha256Hex } from "@/lib/upload/hashServer";
import { tempOriginalPath, tempThumbnailPath, tempPreviewPath } from "@/lib/upload/storagePaths";
import { resolveSignedUrl } from "@/lib/signedUrl";
import { createPerfLog } from "@/lib/perfLog";
import { checkUserRateLimit, rateLimitHeaders } from "@/lib/rateLimit";
import { MAX_ORIGINAL_BYTES, MAX_TOTAL_BYTES, MAX_ORIGINAL_MB } from "@/lib/upload/uploadLimits";
import { reserveSortOrder } from "@/lib/upload/sortOrderReservation";

const BUCKET = "photobox-private";

type OptionalUploadResult = {
  ok: boolean;
  path: string | null;
};

async function prepareOptionalUpload(file: FormDataEntryValue | null, path: string): Promise<{
  path: string;
  buffer: Buffer;
  contentType: string;
} | null> {
  if (!(file instanceof File)) return null;

  const buffer = Buffer.from(await file.arrayBuffer());
  const validation = validateImageFile(file, new Uint8Array(buffer));
  if (!validation.ok) return null;

  return { path, buffer, contentType: validation.mime };
}

async function uploadOptionalFile(prepared: Awaited<ReturnType<typeof prepareOptionalUpload>>): Promise<OptionalUploadResult> {
  if (!prepared) return { ok: true, path: null };

  const { error } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(prepared.path, prepared.buffer, { contentType: prepared.contentType, upsert: false });

  if (error) return { ok: false, path: null };
  return { ok: true, path: prepared.path };
}

export async function POST(request: NextRequest) {
  const perf = createPerfLog("uploads.items");

  // 1. 認証
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();
  perf.mark("authMs");

  // 1.5. rate limit — multipart parse より前に判定する
  // (workspaceId は formData 内の sessionId 経由でしか特定できないため userId のみで制限)
  const rl = await checkUserRateLimit({ preset: "uploadItem", userId: user.id });
  perf.mark("rateLimitMs");
  if (!rl.allowed) {
    return Errors.rateLimited(rateLimitHeaders(rl));
  }

  // 2. multipart parse
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Errors.validation("Failed to parse multipart/form-data");
  }
  perf.mark("formDataMs");

  // 3. sessionId 取得
  const sessionId = formData.get("sessionId");
  if (typeof sessionId !== "string" || !sessionId) {
    return Errors.validation("sessionId is required");
  }

  // 4. session 取得 + 認可
  const session = await prisma.uploadSession.findUnique({
    where: { id: sessionId },
    select: { id: true, workspaceId: true, userId: true, status: true, cleanupLeaseUntil: true },
  });
  if (!session) return Errors.notFound("Session not found");
  if (session.userId !== user.id) return Errors.forbidden();

  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: session.workspaceId, userId: user.id } },
    select: { workspaceId: true },
  });
  if (!member) return Errors.forbidden();

  // 4.5. session cleanup interlock (Phase 10-43-B3c-2)
  // active な session cleanup claim 中は新しい temp object を作らせない
  // (prepare route と同一契約)。lease の値そのものは response へ出さない。
  if (isLeaseActive(session.cleanupLeaseUntil, new Date())) {
    return err("SESSION_CLEANUP_IN_PROGRESS", "This session is being cleaned up. Please retry shortly.", 409);
  }

  // 5. session.status チェック
  if (session.status !== "ACTIVE") {
    return Errors.validation(`Session status is '${session.status}'. Only ACTIVE sessions accept uploads.`);
  }
  perf.mark("sessionMs");

  // 6. ファイル取得
  const originalFile = formData.get("original");
  if (!(originalFile instanceof File)) {
    return Errors.validation("original file is required");
  }

  // 7. サイズチェック
  if (originalFile.size > MAX_ORIGINAL_BYTES) {
    return err("PAYLOAD_TOO_LARGE", `original file exceeds ${MAX_ORIGINAL_MB}MB limit`, 413);
  }

  const thumbnailFile = formData.get("thumbnail");
  const previewFile = formData.get("preview");

  const totalSize =
    originalFile.size +
    (thumbnailFile instanceof File ? thumbnailFile.size : 0) +
    (previewFile instanceof File ? previewFile.size : 0);

  if (totalSize > MAX_TOTAL_BYTES) {
    return err("PAYLOAD_TOO_LARGE", `Total upload exceeds ${MAX_TOTAL_BYTES / 1024 / 1024}MB limit`, 413);
  }

  // 8. original を ArrayBuffer で読む
  const originalBuffer = Buffer.from(await originalFile.arrayBuffer());
  const originalBytes = new Uint8Array(originalBuffer);

  // 9. MIME / magic bytes 検証
  const validation = validateImageFile(originalFile, originalBytes);
  if (!validation.ok) {
    const code = validation.reason === "UNSUPPORTED_MEDIA_TYPE" ? "UNSUPPORTED_MEDIA_TYPE" : "VALIDATION_ERROR";
    return err(code, `Invalid image file: ${validation.reason}`, 415);
  }
  const { mime: mimeType, ext: originalExt } = validation;

  // 10. サーバー側 SHA-256 再計算
  const serverHash = sha256Hex(originalBuffer);

  // 11. clientFileHash と照合
  const clientFileHash = formData.get("clientFileHash");
  if (typeof clientFileHash !== "string" || !clientFileHash) {
    return Errors.validation("clientFileHash is required");
  }
  if (clientFileHash.toLowerCase() !== serverHash.toLowerCase()) {
    return err("FILE_HASH_MISMATCH", "File hash mismatch. The file may have been corrupted during upload.", 400);
  }
  perf.mark("validateHashMs");

  // 12. duplicate check (images テーブルに対して)
  // 注: upload_items 同士の重複はMVPでは判定しない
  // soft-deleted image (status=DELETED / deletedAt) は重複として扱わない。
  // check-duplicates / commit pre-check と同じフィルタで統一する。
  const existingImage = await prisma.image.findFirst({
    where: {
      workspaceId: session.workspaceId,
      fileHash: serverHash,
      deletedAt: null,
      status: { not: "DELETED" },
    },
    select: { id: true },
  });
  const duplicateStatus = existingImage ? "DUPLICATE" : "CLEAN";
  const duplicateImageId = existingImage?.id ?? null;
  perf.mark("duplicateCheckMs");

  // 13. メタデータ取得
  const originalName =
    (typeof formData.get("originalName") === "string" && formData.get("originalName") !== "")
      ? (formData.get("originalName") as string)
      : originalFile.name;

  const widthPx = formData.get("widthPx") ? parseInt(formData.get("widthPx") as string, 10) || null : null;
  const heightPx = formData.get("heightPx") ? parseInt(formData.get("heightPx") as string, 10) || null : null;

  // 14〜17. sortOrder予約 + UploadItem作成を同一transactionで行う。
  // reserveSortOrder() は upload_sessions.next_upload_sort_order を atomic に
  // increment する（旧 aggregate MAX(sortOrder)+1 は並行 upload で同値を返し
  // 得たため置き換えた — Phase 10-43-B1）。同一 tx 内なので、reservation失敗時
  // (session不存在) は create も Storage PUT も一切実行されない。
  // B1 migration の AFTER INSERT trigger もこの tx 内で発火するが、
  // このINSERT時点でcounterは既にreservation.sortOrder+1へ進んでいるため
  // trigger のGREATESTはno-op(二重incrementにならない)。
  const uploadItemId = cuid();
  const storagePath = tempOriginalPath(session.workspaceId, sessionId, uploadItemId, originalExt);
  const thumbnailStoragePath = tempThumbnailPath(session.workspaceId, sessionId, uploadItemId);
  const previewStoragePath = tempPreviewPath(session.workspaceId, sessionId, uploadItemId);

  // B3c-2: transaction 冒頭で session を条件付き guard する(prepare と同型)。
  // cleanup claim CAS と同一 session row の UPDATE なので row lock で直列化され、
  // 「initial read 通過後に cleanup claim が取得される」raceでも、claim 勝者の
  // 後から sortOrder 予約・UploadItem 作成・Storage PUT が始まることはない。
  const guardNow = new Date();
  const reservationResult = await prisma.$transaction(async (tx) => {
    const guarded = await tx.uploadSession.updateMany({
      where: {
        id: sessionId,
        workspaceId: session.workspaceId,
        userId: user.id,
        status: "ACTIVE",
        OR: [{ cleanupLeaseUntil: null }, { cleanupLeaseUntil: { lte: guardNow } }],
      },
      data: { updatedAt: guardNow },
    });
    if (guarded.count === 0) return { ok: false as const, reason: "SESSION_GUARD_FAILED" as const };

    const reservation = await reserveSortOrder(tx, sessionId);
    if (!reservation.ok) return reservation;

    await tx.uploadItem.create({
      data: {
        id: uploadItemId,
        workspaceId: session.workspaceId,
        sessionId,
        sortOrder: reservation.sortOrder,
        originalName,
        originalExt,
        mimeType,
        fileSizeBytes: originalFile.size,
        widthPx,
        heightPx,
        fileHash: serverHash,
        tempStoragePath: storagePath,
        tempThumbnailPath: thumbnailStoragePath,
        tempPreviewPath: previewStoragePath,
        uploadStatus: "UPLOADING",
        promptStatus: "EMPTY",
        duplicateStatus,
        commitStatus: "PENDING",
        duplicateImageId,
      },
    });

    return reservation;
  });

  if (!reservationResult.ok) {
    if (reservationResult.reason === "SESSION_GUARD_FAILED") {
      // guard count=0 を一般 500 へ潰さず、transaction 外で再読込して理由を特定する
      // (prepare の classifySessionRejection と同じ分類)。
      const latest = await prisma.uploadSession.findUnique({
        where: { id: sessionId },
        select: { userId: true, status: true, cleanupLeaseUntil: true },
      });
      if (!latest) return Errors.notFound("Session not found");
      if (latest.userId !== user.id) return Errors.forbidden();
      if (isLeaseActive(latest.cleanupLeaseUntil, new Date())) {
        return err("SESSION_CLEANUP_IN_PROGRESS", "This session is being cleaned up. Please retry shortly.", 409);
      }
      if (latest.status !== "ACTIVE") {
        return Errors.validation(`Session status is '${latest.status}'. Only ACTIVE sessions accept uploads.`);
      }
      return err("CONFLICT", "Session state changed during upload. Please retry.", 409);
    }
    // session は手順4で存在確認済みのため、ここへ到達するのは手順4以降に
    // sessionが削除された場合のみ(レース)。既存のsession不存在時と同じ契約。
    return Errors.notFound("Session not found");
  }
  perf.mark("dbInsertMs");

  // 18. Storage PUT — original / thumbnail / preview を並列化
  // original は必須。thumbnail / preview は失敗しても READY を維持し、表示時に fallback する。
  const [preparedThumbnail, preparedPreview] = await Promise.all([
    prepareOptionalUpload(thumbnailFile, thumbnailStoragePath),
    prepareOptionalUpload(previewFile, previewStoragePath),
  ]);
  perf.mark("prepareVariantsMs");

  const originalUpload = supabaseAdmin.storage
    .from(BUCKET)
    .upload(storagePath, originalBuffer, { contentType: mimeType, upsert: false });

  const [originalResult, thumbnailResult, previewResult] = await Promise.all([
    originalUpload,
    uploadOptionalFile(preparedThumbnail),
    uploadOptionalFile(preparedPreview),
  ]);
  perf.mark("storageUploadMs");

  if (originalResult.error) {
    await Promise.all([
      prisma.uploadItem.update({
        where: { id: uploadItemId },
        data: { uploadStatus: "ERROR" },
      }),
      supabaseAdmin.storage
        .from(BUCKET)
        .remove([thumbnailStoragePath, previewStoragePath])
        .catch(() => undefined),
    ]);
    return err("INTERNAL_ERROR", `Storage upload failed: ${originalResult.error.message}`, 500);
  }

  const actualThumbnailPath = thumbnailResult.ok ? thumbnailResult.path : null;
  const actualPreviewPath = previewResult.ok ? previewResult.path : null;

  // 19. DB UPDATE — READY
  const item = await prisma.uploadItem.update({
    where: { id: uploadItemId },
    data: {
      uploadStatus: "READY",
      tempThumbnailPath: actualThumbnailPath,
      tempPreviewPath: actualPreviewPath,
    },
    select: {
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
      duplicateStatus: true,
      duplicateImageId: true,
      commitStatus: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  perf.mark("dbReadyMs");

  // 20. signed URLs を発行して返す
  const [thumbResult, previewResultSigned, originalResultSigned] = await Promise.all([
    resolveSignedUrl("uploadItem", uploadItemId, "thumbnail", user.id, 0),
    resolveSignedUrl("uploadItem", uploadItemId, "preview", user.id, 1),
    resolveSignedUrl("uploadItem", uploadItemId, "original", user.id, 2),
  ]);
  perf.mark("signedUrlMs");

  function toSignedUrlEntry(result: typeof thumbResult) {
    if ("reason" in result) return { signedUrl: null, fallback: null };
    return { signedUrl: result.signedUrl, fallback: result.fallback };
  }

  perf.end({
    originalBytes: originalFile.size,
    totalBytes: totalSize,
    hasThumbnail: preparedThumbnail !== null,
    hasPreview: preparedPreview !== null,
    duplicateStatus,
    rateLimitEnabled: rl.enabled,
    rateLimitSource: rl.source,
  });

  return ok(
    {
      item,
      signedUrls: {
        thumbnail: toSignedUrlEntry(thumbResult),
        preview: toSignedUrlEntry(previewResultSigned),
        original: toSignedUrlEntry(originalResultSigned),
      },
    },
    201,
  );
}
