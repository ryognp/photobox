import "server-only";

export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { ok, Errors } from "@/lib/apiResponse";
import { getSignedUrlCache, setSignedUrlCache } from "@/lib/supabase/signedUrlCache";
import { resolveWorkspaceImage } from "@/lib/images/resolveWorkspaceImage";
import { isTranslationEnabled } from "@/lib/translation/translationProviderFactory";

const BUCKET = "photobox-private";

async function signedUrl(storagePath: string | null, expirySeconds: number): Promise<string | null> {
  if (!storagePath) return null;
  const cached = getSignedUrlCache(storagePath);
  if (cached) return cached;
  const { data, error } = await supabaseAdmin.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, expirySeconds);
  if (error || !data?.signedUrl) return null;
  setSignedUrlCache(storagePath, data.signedUrl);
  return data.signedUrl;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();

  const { id } = await params;

  // Fetch + workspace membership in one call; image is exposed only when ok.
  const resolved = await resolveWorkspaceImage({
    id,
    userId: user.id,
    select: {
      id: true,
      workspaceId: true,
      originalName: true,
      originalExt: true,
      mimeType: true,
      fileSizeBytes: true,
      widthPx: true,
      heightPx: true,
      fileHash: true,
      isFavorite: true,
      rating: true,
      notes: true,
      status: true,
      storagePath: true,
      thumbnailPath: true,
      previewPath: true,
      deletedAt: true,
      createdAt: true,
      updatedAt: true,
      sourceSheetName: true,
      sourceRow: true,
      sourceColumn: true,
      importBatchId: true,
      scene: { select: { id: true, name: true } },
      imageTags: { select: { tag: { select: { id: true, name: true } } } },
      imagePersons: { select: { person: { select: { id: true, name: true } } } },
      tagSuggestions: {
        where: { status: "PENDING" },
        select: { id: true, label: true, confidence: true, status: true },
        orderBy: { createdAt: "asc" },
      },
      prompt: {
        select: {
          id: true,
          currentBody: true,
          originalBody: true,
          createdAt: true,
          // Phase 10-9C-3: translation cache fields (read-only display).
          translatedBodyJa: true,
          translatedFromBodyHash: true,
          translationStatus: true,
          translationProvider: true,
          translationModel: true,
          translatedAt: true,
          translationStartedAt: true,
          translationError: true,
          versions: {
            select: {
              id: true,
              versionType: true,
              body: true,
              changeNote: true,
              createdAt: true,
              scene: { select: { id: true, name: true } },
            },
            orderBy: { createdAt: "desc" },
            take: 20,
          },
        },
      },
    },
  });

  if (resolved.kind === "not_found") return Errors.notFound("Image not found");
  if (resolved.kind === "forbidden") return Errors.forbidden();
  const image = resolved.image;

  // Deleted / non-ACTIVE images are 404 (evaluated after auth — Phase 8B Step 2,
  // case A: a cross-workspace deleted image now returns 403 instead of the prior
  // 404, which is an intentional, more-consistent hardening).
  if (image.deletedAt !== null || image.status !== "ACTIVE") {
    return Errors.notFound("Image not found");
  }

  const [thumbnailUrl, previewUrl, originalUrl] = await Promise.all([
    signedUrl(image.thumbnailPath ?? image.previewPath ?? image.storagePath, 900),
    signedUrl(image.previewPath ?? image.storagePath, 600),
    signedUrl(image.storagePath, 300),
  ]);

  return ok({
    id: image.id,
    originalName: image.originalName,
    originalExt: image.originalExt,
    mimeType: image.mimeType,
    fileSizeBytes: image.fileSizeBytes,
    widthPx: image.widthPx,
    heightPx: image.heightPx,
    fileHashSnippet: image.fileHash ? image.fileHash.slice(0, 12) : null,
    isFavorite: image.isFavorite,
    rating: image.rating,
    notes: image.notes,
    createdAt: image.createdAt,
    updatedAt: image.updatedAt,
    sourceSheetName: image.sourceSheetName,
    sourceRow: image.sourceRow,
    sourceColumn: image.sourceColumn,
    importBatchId: image.importBatchId,
    scene: image.scene,
    tags: image.imageTags.map((t) => t.tag),
    persons: image.imagePersons.map((p) => p.person),
    tagSuggestions: image.tagSuggestions,
    prompt: image.prompt,
    signedUrls: { thumbnailUrl, previewUrl, originalUrl },
    // Phase 10-9C-3: whether the DetailPanel translation UI (10-9C-4) may run.
    translationEnabled: isTranslationEnabled(process.env),
  });
}

/**
 * Soft delete (Phase 1): sets status=DELETED + deletedAt=now.
 * Storage objects are NOT removed here — that is handled by a later
 * cleanup/audit task. prompt / versions / tags / persons are preserved.
 * Idempotent: deleting an already-deleted image returns 200.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();

  const { id } = await params;

  const resolved = await resolveWorkspaceImage({
    id,
    userId: user.id,
    select: { id: true, workspaceId: true, status: true, deletedAt: true },
  });

  if (resolved.kind === "not_found") return Errors.notFound("Image not found");
  if (resolved.kind === "forbidden") return Errors.forbidden();
  const image = resolved.image;

  if (image.deletedAt !== null || image.status === "DELETED") {
    return ok({ deleted: true, alreadyDeleted: true, imageId: image.id });
  }

  // updateMany with status/deletedAt guards → safe under concurrent deletes.
  await prisma.image.updateMany({
    where: {
      id: image.id,
      workspaceId: image.workspaceId,
      deletedAt: null,
      status: { not: "DELETED" },
    },
    data: { status: "DELETED", deletedAt: new Date() },
  });

  return ok({ deleted: true, alreadyDeleted: false, imageId: image.id });
}
