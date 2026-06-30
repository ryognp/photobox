import "server-only";

import { prisma } from "./prisma";
import { supabaseAdmin } from "./supabase/admin";

const BUCKET = "photobox-private";

export type ItemType = "image" | "uploadItem";
export type Variant = "thumbnail" | "preview" | "original";

const VALID_TYPES = new Set<string>(["image", "uploadItem"]);
const VALID_VARIANTS = new Set<string>(["thumbnail", "preview", "original"]);

// 余計なキーを許可しない（path / bucket 等の直接指定を拒否）
const ALLOWED_KEYS = new Set(["type", "id", "variant"]);

export function hasExtraKeys(obj: Record<string, unknown>): boolean {
  return Object.keys(obj).some((k) => !ALLOWED_KEYS.has(k));
}

export function isValidItemType(v: unknown): v is ItemType {
  return typeof v === "string" && VALID_TYPES.has(v);
}

export function isValidVariant(v: unknown): v is Variant {
  return typeof v === "string" && VALID_VARIANTS.has(v);
}

// 有効期限（秒）
const EXPIRY: Record<Variant, number> = {
  thumbnail: 900,
  preview: 600,
  original: 300,
};

// fallback chain
const FALLBACK_CHAIN: Record<Variant, Variant[]> = {
  thumbnail: ["thumbnail", "preview", "original"],
  preview: ["preview", "original"],
  original: ["original"],
};

export type SignedUrlResult = {
  index: number;
  type: ItemType;
  id: string;
  variant: Variant;
  signedUrl: string | null;
  expiresAt: string | null;
  fallback: boolean | null;
};

export type SignedUrlFailure = {
  index: number;
  type: string;
  id: string;
  variant: string;
  reason: "NOT_FOUND" | "FORBIDDEN" | "NO_PATH" | "INVALID_REQUEST";
};

type StoragePaths = {
  thumbnail: string | null;
  preview: string | null;
  original: string | null;
};

async function resolveStoragePaths(
  type: ItemType,
  id: string,
  userId: string,
): Promise<StoragePaths | "NOT_FOUND" | "FORBIDDEN"> {
  if (type === "image") {
    const image = await prisma.image.findUnique({
      where: { id },
      select: {
        workspaceId: true,
        storagePath: true,
        thumbnailPath: true,
        previewPath: true,
        deletedAt: true,
      },
    });

    if (!image || image.deletedAt !== null) return "NOT_FOUND";

    const member = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: image.workspaceId, userId } },
      select: { workspaceId: true },
    });
    if (!member) return "FORBIDDEN";

    return {
      thumbnail: image.thumbnailPath,
      preview: image.previewPath,
      original: image.storagePath,
    };
  }

  // uploadItem
  const item = await prisma.uploadItem.findUnique({
    where: { id },
    select: {
      workspaceId: true,
      tempStoragePath: true,
      tempThumbnailPath: true,
      tempPreviewPath: true,
    },
  });

  if (!item) return "NOT_FOUND";

  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: item.workspaceId, userId } },
    select: { workspaceId: true },
  });
  if (!member) return "FORBIDDEN";

  return {
    thumbnail: item.tempThumbnailPath,
    preview: item.tempPreviewPath,
    original: item.tempStoragePath,
  };
}

function pickPath(paths: StoragePaths, chain: Variant[]): { path: string; variant: Variant } | null {
  for (const v of chain) {
    const p = paths[v];
    if (p) return { path: p, variant: v };
  }
  return null;
}

async function issueSignedUrl(
  path: string,
  variant: Variant,
): Promise<{ signedUrl: string; expiresAt: string } | null> {
  const { data, error } = await supabaseAdmin.storage
    .from(BUCKET)
    .createSignedUrl(path, EXPIRY[variant]);

  if (error || !data?.signedUrl) return null;

  const expiresAt = new Date(Date.now() + EXPIRY[variant] * 1000).toISOString();
  return { signedUrl: data.signedUrl, expiresAt };
}

export async function resolveSignedUrl(
  type: ItemType,
  id: string,
  variant: Variant,
  userId: string,
  index: number,
): Promise<SignedUrlResult | SignedUrlFailure> {
  const paths = await resolveStoragePaths(type, id, userId);

  if (paths === "NOT_FOUND") return { index, type, id, variant, reason: "NOT_FOUND" };
  if (paths === "FORBIDDEN") return { index, type, id, variant, reason: "FORBIDDEN" };

  const chain = FALLBACK_CHAIN[variant];
  const picked = pickPath(paths, chain);

  if (!picked) {
    return { index, type, id, variant, signedUrl: null, expiresAt: null, fallback: null };
  }

  const issued = await issueSignedUrl(picked.path, picked.variant);
  if (!issued) {
    return { index, type, id, variant, signedUrl: null, expiresAt: null, fallback: null };
  }

  return {
    index,
    type,
    id,
    variant,
    signedUrl: issued.signedUrl,
    expiresAt: issued.expiresAt,
    fallback: picked.variant !== variant,
  };
}

export function isFailure(r: SignedUrlResult | SignedUrlFailure): r is SignedUrlFailure {
  return "reason" in r;
}

export type BatchRequest = { index: number; type: ItemType; id: string; variant: Variant };

export async function resolveSignedUrls(
  requests: BatchRequest[],
  userId: string,
): Promise<{ results: SignedUrlResult[]; failed: SignedUrlFailure[] }> {
  const settled = await Promise.all(
    requests.map((req) => resolveSignedUrl(req.type, req.id, req.variant, userId, req.index)),
  );

  const results: SignedUrlResult[] = [];
  const failed: SignedUrlFailure[] = [];

  for (const r of settled) {
    if (isFailure(r)) {
      failed.push(r);
    } else {
      results.push(r);
    }
  }

  return { results, failed };
}
