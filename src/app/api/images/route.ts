import "server-only";

export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { getCurrentUser, getDefaultWorkspaceForUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { ok, Errors } from "@/lib/apiResponse";
import { createPerfLog } from "@/lib/perfLog";
import { getSignedUrlCache, setSignedUrlCache, getSignedUrlCacheStats } from "@/lib/supabase/signedUrlCache";

const BUCKET = "photobox-private";
const THUMB_EXPIRY = 900; // 15min
const LIMIT_MAX = 100;
const LIMIT_DEFAULT = 48;

async function signedUrlMap(paths: string[], expiry: number): Promise<Map<string, string>> {
  const uniquePaths = Array.from(new Set(paths.filter(Boolean)));
  const map = new Map<string, string>();
  if (uniquePaths.length === 0) return map;

  // Serve cached URLs; collect paths that need signing
  const uncached: string[] = [];
  for (const p of uniquePaths) {
    const cached = getSignedUrlCache(p);
    if (cached) {
      map.set(p, cached);
    } else {
      uncached.push(p);
    }
  }

  if (uncached.length === 0) return map;

  const { data, error } = await supabaseAdmin.storage
    .from(BUCKET)
    .createSignedUrls(uncached, expiry);

  if (error || !data) return map;

  for (const entry of data) {
    if (entry.path && entry.signedUrl) {
      map.set(entry.path, entry.signedUrl);
      setSignedUrlCache(entry.path, entry.signedUrl);
    }
  }

  return map;
}

export async function GET(request: NextRequest) {
  const perf = createPerfLog("gallery.images");

  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();

  const workspace = await getDefaultWorkspaceForUser(user.id);
  if (!workspace) return Errors.forbidden();
  perf.mark("authMs");

  const sp = request.nextUrl.searchParams;
  const q = sp.get("q")?.trim() ?? "";
  const sceneId = sp.get("sceneId") ?? null;
  const tagId = sp.get("tagId") ?? null;
  const personId = sp.get("personId") ?? null;
  const favorite = sp.get("favorite") === "true" ? true : null;
  const cursor = sp.get("cursor") ?? null;
  const sort = sp.get("sort") === "oldest" ? "asc" : "desc";
  const limitRaw = parseInt(sp.get("limit") ?? String(LIMIT_DEFAULT), 10);
  const limit = Math.min(isNaN(limitRaw) || limitRaw < 1 ? LIMIT_DEFAULT : limitRaw, LIMIT_MAX);

  const qFilter = q
    ? {
        OR: [
          { searchText: { contains: q, mode: "insensitive" as const } },
          { originalName: { contains: q, mode: "insensitive" as const } },
          { notes: { contains: q, mode: "insensitive" as const } },
          { prompt: { currentBody: { contains: q, mode: "insensitive" as const } } },
          { prompt: { originalBody: { contains: q, mode: "insensitive" as const } } },
        ],
      }
    : {};

  const where = {
    workspaceId: workspace.id,
    deletedAt: null,
    status: "ACTIVE" as const,
    ...qFilter,
    ...(sceneId ? { sceneId } : {}),
    ...(favorite !== null ? { isFavorite: favorite } : {}),
    ...(tagId ? { imageTags: { some: { tagId } } } : {}),
    ...(personId ? { imagePersons: { some: { personId } } } : {}),
  };

  const images = await prisma.image.findMany({
    where,
    orderBy: [{ createdAt: sort }, { id: sort }],
    ...(cursor
      ? {
          cursor: { id: cursor },
          skip: 1,
        }
      : {}),
    take: limit + 1,
    select: {
      id: true,
      originalName: true,
      widthPx: true,
      heightPx: true,
      thumbnailPath: true,
      previewPath: true,
      isFavorite: true,
      rating: true,
      createdAt: true,
      scene: { select: { id: true, name: true } },
      imageTags: { select: { tag: { select: { id: true, name: true } } } },
      imagePersons: { select: { person: { select: { id: true, name: true } } } },
      prompt: {
        select: {
          currentBody: true,
          _count: { select: { versions: true } },
        },
      },
    },
  });
  perf.mark("dbMs");

  const hasMore = images.length > limit;
  const page = hasMore ? images.slice(0, limit) : images;
  const nextCursor = hasMore ? page[page.length - 1].id : null;

  const thumbnailUrls = await signedUrlMap(
    page.map((img) => img.thumbnailPath).filter((path): path is string => Boolean(path)),
    THUMB_EXPIRY,
  );

  const fallbackPreviewUrls = await signedUrlMap(
    page
      .filter((img) => !img.thumbnailPath || !thumbnailUrls.has(img.thumbnailPath))
      .map((img) => img.previewPath)
      .filter((path): path is string => Boolean(path)),
    THUMB_EXPIRY,
  );
  const urlCacheStats = getSignedUrlCacheStats();
  perf.mark("signedUrlMs");

  const withUrls = page.map((img) => {
    const thumbnailUrl = img.thumbnailPath ? thumbnailUrls.get(img.thumbnailPath) ?? null : null;
    const fallbackUrl = !thumbnailUrl && img.previewPath ? fallbackPreviewUrls.get(img.previewPath) ?? null : null;

    return {
      id: img.id,
      originalName: img.originalName,
      widthPx: img.widthPx,
      heightPx: img.heightPx,
      isFavorite: img.isFavorite,
      rating: img.rating,
      createdAt: img.createdAt,
      scene: img.scene,
      tags: img.imageTags.map((t) => t.tag),
      persons: img.imagePersons.map((p) => p.person),
      promptSnippet: img.prompt?.currentBody?.slice(0, 80) ?? null,
      promptVersionCount: img.prompt?._count?.versions ?? 0,
      thumbnailUrl: thumbnailUrl ?? fallbackUrl,
    };
  });
  perf.mark("serializeMs");
  perf.end({
    imageCount: page.length,
    hasMore,
    hasQuery: q.length > 0,
    hasCursor: cursor !== null,
    limit,
    urlCacheSize: urlCacheStats.size,
  });

  return ok({ images: withUrls, nextCursor });
}
