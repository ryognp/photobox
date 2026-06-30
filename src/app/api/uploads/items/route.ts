export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import cuid from "cuid";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { err, ok, Errors } from "@/lib/apiResponse";
import { validateImageFile } from "@/lib/upload/validateImage";
import { sha256Hex } from "@/lib/upload/hashServer";
import { tempOriginalPath, tempThumbnailPath, tempPreviewPath } from "@/lib/upload/storagePaths";
import { resolveSignedUrl } from "@/lib/signedUrl";

const BUCKET = "photobox-private";
const MAX_ORIGINAL_BYTES = 3 * 1024 * 1024; // 3MB
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;    // 4MB

export async function POST(request: NextRequest) {
  // 1. 認証
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();

  // 2. multipart parse
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Errors.validation("Failed to parse multipart/form-data");
  }

  // 3. sessionId 取得
  const sessionId = formData.get("sessionId");
  if (typeof sessionId !== "string" || !sessionId) {
    return Errors.validation("sessionId is required");
  }

  // 4. session 取得 + 認可
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

  // 5. session.status チェック
  if (session.status !== "ACTIVE") {
    return Errors.validation(`Session status is '${session.status}'. Only ACTIVE sessions accept uploads.`);
  }

  // 6. ファイル取得
  const originalFile = formData.get("original");
  if (!(originalFile instanceof File)) {
    return Errors.validation("original file is required");
  }

  // 7. サイズチェック
  if (originalFile.size > MAX_ORIGINAL_BYTES) {
    return err("PAYLOAD_TOO_LARGE", `original file exceeds ${MAX_ORIGINAL_BYTES / 1024 / 1024}MB limit`, 413);
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

  // 12. duplicate check (images テーブルに対して)
  // 注: upload_items 同士の重複はMVPでは判定しない
  const existingImage = await prisma.image.findUnique({
    where: { workspaceId_fileHash: { workspaceId: session.workspaceId, fileHash: serverHash } },
    select: { id: true },
  });
  const duplicateStatus = existingImage ? "DUPLICATE" : "CLEAN";
  const duplicateImageId = existingImage?.id ?? null;

  // 13. メタデータ取得
  const originalName =
    (typeof formData.get("originalName") === "string" && formData.get("originalName") !== "")
      ? (formData.get("originalName") as string)
      : originalFile.name;

  const widthPx = formData.get("widthPx") ? parseInt(formData.get("widthPx") as string, 10) || null : null;
  const heightPx = formData.get("heightPx") ? parseInt(formData.get("heightPx") as string, 10) || null : null;

  // 14. sortOrder 計算
  const maxOrder = await prisma.uploadItem.aggregate({
    where: { sessionId },
    _max: { sortOrder: true },
  });
  const sortOrder = (maxOrder._max.sortOrder ?? -1) + 1;

  // 15. uploadItemId を先に生成（tempStoragePath に必要）
  const uploadItemId = cuid();

  // 16. Storage paths を確定
  const storagePath = tempOriginalPath(session.workspaceId, sessionId, uploadItemId, originalExt);
  const thumbnailStoragePath = tempThumbnailPath(session.workspaceId, sessionId, uploadItemId);
  const previewStoragePath = tempPreviewPath(session.workspaceId, sessionId, uploadItemId);

  // 17. DB INSERT (status = UPLOADING)
  await prisma.uploadItem.create({
    data: {
      id: uploadItemId,
      workspaceId: session.workspaceId,
      sessionId,
      sortOrder,
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

  // 18. Storage PUT — original (必須)
  const { error: originalError } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(storagePath, originalBuffer, { contentType: mimeType, upsert: false });

  if (originalError) {
    await prisma.uploadItem.update({
      where: { id: uploadItemId },
      data: { uploadStatus: "ERROR" },
    });
    return err("INTERNAL_ERROR", `Storage upload failed: ${originalError.message}`, 500);
  }

  // 19. Storage PUT — thumbnail / preview (任意)
  // MIME / magic bytes が許可外の場合は null 扱い（original が成功していれば READY のまま）
  let actualThumbnailPath: string | null = null;
  let actualPreviewPath: string | null = null;

  if (thumbnailFile instanceof File) {
    const thumbBuf = Buffer.from(await thumbnailFile.arrayBuffer());
    const thumbValidation = validateImageFile(thumbnailFile, new Uint8Array(thumbBuf));
    if (thumbValidation.ok) {
      const { error } = await supabaseAdmin.storage
        .from(BUCKET)
        .upload(thumbnailStoragePath, thumbBuf, { contentType: thumbValidation.mime, upsert: false });
      if (!error) actualThumbnailPath = thumbnailStoragePath;
    }
    // MIME 不正 or upload 失敗 → null のまま（original 成功なので READY は維持）
  }

  if (previewFile instanceof File) {
    const prevBuf = Buffer.from(await previewFile.arrayBuffer());
    const prevValidation = validateImageFile(previewFile, new Uint8Array(prevBuf));
    if (prevValidation.ok) {
      const { error } = await supabaseAdmin.storage
        .from(BUCKET)
        .upload(previewStoragePath, prevBuf, { contentType: prevValidation.mime, upsert: false });
      if (!error) actualPreviewPath = previewStoragePath;
    }
  }

  // 20. DB UPDATE — READY
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

  // 21. signed URLs を発行して返す
  const [thumbResult, previewResult, originalResult] = await Promise.all([
    resolveSignedUrl("uploadItem", uploadItemId, "thumbnail", user.id, 0),
    resolveSignedUrl("uploadItem", uploadItemId, "preview", user.id, 1),
    resolveSignedUrl("uploadItem", uploadItemId, "original", user.id, 2),
  ]);

  function toSignedUrlEntry(result: typeof thumbResult) {
    if ("reason" in result) return { signedUrl: null, fallback: null };
    return { signedUrl: result.signedUrl, fallback: result.fallback };
  }

  return ok(
    {
      item,
      signedUrls: {
        thumbnail: toSignedUrlEntry(thumbResult),
        preview: toSignedUrlEntry(previewResult),
        original: toSignedUrlEntry(originalResult),
      },
    },
    201,
  );
}
