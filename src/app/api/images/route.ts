import "server-only";

export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { getDefaultWorkspaceForUserCached } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { ok, Errors } from "@/lib/apiResponse";
import { createPerfLog } from "@/lib/perfLog";
import { getSignedUrlCacheAsync, setSignedUrlCacheAsync, getSignedUrlCacheStats } from "@/lib/supabase/signedUrlCache";
import { getWorkspaceCacheStats } from "@/lib/cache/workspaceCache";

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
  // Check Redis + in-process cache for each path concurrently
  const cacheResults = await Promise.all(uniquePaths.map((p) => getSignedUrlCacheAsync(p)));
  for (let i = 0; i < uniquePaths.length; i++) {
    const p = uniquePaths[i];
    const cached = cacheResults[i];
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

  await Promise.all(
    data
      .filter((entry): entry is typeof entry & { path: string; signedUrl: string } =>
        Boolean(entry.path && entry.signedUrl),
      )
      .map((entry) => {
        map.set(entry.path, entry.signedUrl);
        return setSignedUrlCacheAsync(entry.path, entry.signedUrl);
      }),
  );

  return map;
}

export async function GET(request: NextRequest) {
  const perf = createPerfLog("gallery.images");

  // ── Auth breakdown ──────────────────────────────────────────────────────
  // Step 1: cookies() + createServerClient (sync setup, no network)
  const supabase = await createClient();
  perf.mark("authCreateClientMs");

  // Step 2: supabase.auth.getUser() — validates JWT via Supabase Auth API (1 RTT)
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Errors.unauthorized();
  perf.mark("authGetUserMs");

  // Step 3: workspaceMember.findFirst + workspace JOIN (cached, TTL 5min)
  const { workspace, cacheSource: workspaceCacheSource } = await getDefaultWorkspaceForUserCached(user.id);
  if (!workspace) return Errors.forbidden();
  perf.mark("authWorkspaceMs");

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

  // ── DB breakdown ───────────────────────────────────────────────────────
  // Single findMany with relations (scene, imageTags→tag, imagePersons→person,
  // prompt+_count). Prisma may issue separate SELECT per relation type.
  // Active filters logged in perf.end() for correlation.
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
  // dbFindManyMs = full findMany including all relation fetches
  perf.mark("dbFindManyMs");

  const hasMore = images.length > limit;
  const page = hasMore ? images.slice(0, limit) : images;
  const nextCursor = hasMore ? page[page.length - 1].id : null;
  // dbSliceMs = in-memory hasMore/page/cursor (should be ~0ms)
  perf.mark("dbSliceMs");

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
  // Count images that had scene / tags / persons / prompt (helps correlate dbMs)
  const sceneCount   = page.filter((img) => img.scene).length;
  const tagCount     = page.reduce((n, img) => n + img.imageTags.length, 0);
  const personCount  = page.reduce((n, img) => n + img.imagePersons.length, 0);
  const promptCount  = page.filter((img) => img.prompt).length;

  const workspaceCacheStats = getWorkspaceCacheStats();

  perf.end({
    imageCount: page.length,
    hasMore,
    // Shared cache enabled (Upstash Redis configured)
    sharedCacheEnabled: workspaceCacheStats.sharedCacheEnabled,
    // Instance identity — same ID = same process; different = cold start / new lambda
    cacheInstanceId: workspaceCacheStats.instanceId,
    // Auth cache: "shared" | "memory" | "miss"
    workspaceCacheSource,
    workspaceCacheMemSize: workspaceCacheStats.memSize,
    // DB filters active during findMany
    hasQuery: q.length > 0,
    hasCursor: cursor !== null,
    hasTagFilter: !!tagId,
    hasPersonFilter: !!personId,
    hasSceneFilter: !!sceneId,
    hasFavoriteFilter: favorite !== null,
    sort,
    limit,
    // Relation row counts (how much data the DB returned)
    sceneCount,
    tagCount,
    personCount,
    promptCount,
    // Signed URL cache (Redis shared or in-process Map)
    urlCacheSize: urlCacheStats.size,
    urlCacheShared: urlCacheStats.sharedCacheEnabled,
  });

  return ok({ images: withUrls, nextCursor });
}
