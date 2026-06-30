import "server-only";

import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { ok, Errors } from "@/lib/apiResponse";

const BUCKET = "photobox-private";

async function signedUrl(path: string | null, expirySeconds: number): Promise<string | null> {
  if (!path) return null;
  const { data, error } = await supabaseAdmin.storage
    .from(BUCKET)
    .createSignedUrl(path, expirySeconds);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();

  const { id } = await params;

  const image = await prisma.image.findUnique({
    where: { id },
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
      prompt: {
        select: {
          id: true,
          currentBody: true,
          originalBody: true,
          createdAt: true,
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

  if (!image || image.deletedAt !== null) return Errors.notFound("Image not found");

  // workspace membership check
  const member = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: { workspaceId: image.workspaceId, userId: user.id },
    },
    select: { workspaceId: true },
  });
  if (!member) return Errors.forbidden();

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
    prompt: image.prompt,
    signedUrls: { thumbnailUrl, previewUrl, originalUrl },
  });
}
