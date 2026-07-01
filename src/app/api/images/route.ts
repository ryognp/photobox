import "server-only";

export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { getDefaultWorkspaceForUserCached } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { ok, Errors } from "@/lib/apiResponse";
import { Prisma } from "@/generated/prisma/client";
import { createPerfLog } from "@/lib/perfLog";
import { getSignedUrlCacheAsync, setSignedUrlCacheAsync, getSignedUrlCacheStats } from "@/lib/supabase/signedUrlCache";
import { getWorkspaceCacheStats } from "@/lib/cache/workspaceCache";
import { getAuthUserCache, setAuthUserCache, type AuthUserCacheSource } from "@/lib/cache/authUserCache";
import { getDatabaseUrl } from "@/lib/database-url";

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

// Derive DB connection metadata from DATABASE_URL host — no secret emitted.
function getDbUrlMeta(): { dbUrlMode: string; dbHostRegionHint: string } {
  let host = "";
  try {
    host = new URL(getDatabaseUrl()).hostname;
  } catch {
    return { dbUrlMode: "unknown", dbHostRegionHint: "unknown" };
  }
  const port = new URL(getDatabaseUrl()).port;
  const isPooler = host.includes("pooler.supabase.com");
  const isDirect = host.match(/^db\.[^.]+\.supabase\.co$/) !== null;
  const dbUrlMode = isPooler
    ? port === "6543" ? "pooler-transaction" : "pooler-session"
    : isDirect ? "direct"
    : "unknown";
  const regionMatch = host.match(/aws-\d+-([^.]+)\.pooler\.supabase\.com/) ??
                      host.match(/db\.([^.]+)\.supabase\.co/);
  const dbHostRegionHint = regionMatch ? regionMatch[1] : "unknown";
  return { dbUrlMode, dbHostRegionHint };
}
const { dbUrlMode, dbHostRegionHint } = getDbUrlMeta();

export async function GET(request: NextRequest) {
  const perf = createPerfLog("gallery.images");

  // ── Auth breakdown ──────────────────────────────────────────────────────
  // Step 1: cookies() + createServerClient (sync setup, no network)
  const supabase = await createClient();
  perf.mark("authCreateClientMs");

  // Step 2: getUser() with Redis short-term auth cache (TTL 60s)
  // Cache key = SHA-256(access_token) — token never stored or logged.
  // On cache hit: skip getUser() network call (~770ms saved).
  // On cache miss: call getUser(), cache user.id if valid.
  //
  // Access token is read directly from request.cookies to avoid
  // getSession()'s token-refresh side effects in SSR without middleware.
  // @supabase/ssr stores the session as JSON in sb-{ref}-auth-token,
  // chunked into .0/.1/... suffixes when the value exceeds cookie size limit.

  const supabaseProjectRef = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "")
    .match(/\/\/([^.]+)\.supabase\.co/)?.[1] ?? "";
  const authCookieName = `sb-${supabaseProjectRef}-auth-token`;

  // Reassemble chunked cookie (.0, .1, ...) or read single cookie
  const cookieChunks: string[] = [];
  for (let i = 0; ; i++) {
    const chunk = request.cookies.get(`${authCookieName}.${i}`)?.value;
    if (!chunk) break;
    cookieChunks.push(chunk);
  }
  const authCookieChunkCount = cookieChunks.length;
  const authCookieNameFound =
    authCookieChunkCount > 0 ||
    request.cookies.get(authCookieName) !== undefined;
  const rawSession = authCookieChunkCount > 0
    ? cookieChunks.join("")
    : request.cookies.get(authCookieName)?.value ?? null;
  const authRawSessionLength = rawSession?.length ?? 0;

  // Parse the cookie value to extract access_token.
  // @supabase/ssr formats: plain JSON, OR "base64-" + base64url(JSON),
  // OR URL-encoded JSON. Array format: [session, ...] also possible.
  type ParsedSession = { access_token?: string; currentSession?: { access_token?: string } };
  let accessToken: string | null = null;
  let authCookieParseMode: "json" | "decoded-json" | "array" | "failed" | "none" = "none";

  if (rawSession) {
    // Attempt 1: plain JSON
    try {
      const parsed = JSON.parse(rawSession) as ParsedSession | ParsedSession[];
      if (Array.isArray(parsed)) {
        accessToken = parsed[0]?.access_token ?? parsed[0]?.currentSession?.access_token ?? null;
        authCookieParseMode = "array";
      } else {
        accessToken = parsed.access_token ?? parsed.currentSession?.access_token ?? null;
        authCookieParseMode = "json";
      }
    } catch {
      // Attempt 2: "base64-" prefix (base64url-encoded JSON)
      const BASE64_PREFIX = "base64-";
      const valueToTry = rawSession.startsWith(BASE64_PREFIX)
        ? rawSession.substring(BASE64_PREFIX.length)
        : null;
      if (valueToTry) {
        try {
          // base64url → Buffer → string → JSON
          const decoded = Buffer.from(valueToTry, "base64url").toString("utf-8");
          const parsed = JSON.parse(decoded) as ParsedSession | ParsedSession[];
          if (Array.isArray(parsed)) {
            accessToken = parsed[0]?.access_token ?? parsed[0]?.currentSession?.access_token ?? null;
          } else {
            accessToken = parsed.access_token ?? parsed.currentSession?.access_token ?? null;
          }
          authCookieParseMode = "decoded-json";
        } catch {
          authCookieParseMode = "failed";
        }
      } else {
        // Attempt 3: URL-encoded JSON
        try {
          const decoded = decodeURIComponent(rawSession);
          const parsed = JSON.parse(decoded) as ParsedSession | ParsedSession[];
          if (Array.isArray(parsed)) {
            accessToken = parsed[0]?.access_token ?? parsed[0]?.currentSession?.access_token ?? null;
            authCookieParseMode = "array";
          } else {
            accessToken = parsed.access_token ?? parsed.currentSession?.access_token ?? null;
            authCookieParseMode = "decoded-json";
          }
        } catch {
          authCookieParseMode = "failed";
        }
      }
    }
  }

  const authTokenAvailable = accessToken !== null;
  // We only compute SHA-256 inside getAuthUserCache; note availability without hashing here
  const authTokenHashAvailable = authTokenAvailable;

  let userId: string | null = null;
  let authUserCacheSource: AuthUserCacheSource = "miss";
  let authUserCacheWriteAttempted = false;
  let authUserCacheWriteOk = false;

  if (accessToken) {
    const cached = await getAuthUserCache(accessToken);
    if (cached.userId) {
      userId = cached.userId;
      authUserCacheSource = cached.source;
    }
  }

  if (!userId) {
    // Cache miss — validate JWT via Supabase Auth API (1 RTT)
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return Errors.unauthorized();
    userId = user.id;
    authUserCacheSource = "miss";
    if (accessToken) {
      authUserCacheWriteAttempted = true;
      try {
        await setAuthUserCache(accessToken, userId);
        authUserCacheWriteOk = true;
      } catch {
        authUserCacheWriteOk = false;
      }
    }
  }

  perf.mark("authGetUserMs");

  // Step 3: workspaceMember.findFirst + workspace JOIN (cached, TTL 5min)
  const { workspace, cacheSource: workspaceCacheSource } = await getDefaultWorkspaceForUserCached(userId);
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
  const debugDb = sp.get("debugDb") === "1";
  const debugAuth = sp.get("debugAuth") === "1";

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

  // ── debugDb: staged query breakdown (?debugDb=1 only) ──────────────────
  // Runs 4 sequential findMany with increasing select depth to isolate which
  // relation is expensive. Does NOT affect the normal response path below.
  if (debugDb) {
    const dbgOrderBy: Prisma.ImageOrderByWithRelationInput[] = [{ createdAt: sort }, { id: sort }];
    const dbgBase = {
      where, orderBy: dbgOrderBy, take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    };
    const baseSelect = {
      id: true, originalName: true, widthPx: true, heightPx: true,
      thumbnailPath: true, previewPath: true, isFavorite: true, rating: true, createdAt: true,
    };

    // ── Phase 1: original staged breakdown ──────────────────────────────────
    const t0 = Date.now();
    await prisma.image.findMany({ ...dbgBase, select: baseSelect });
    const t1 = Date.now();
    await prisma.image.findMany({ ...dbgBase, select: { ...baseSelect,
      scene: { select: { id: true, name: true } } } });
    const t2 = Date.now();
    await prisma.image.findMany({ ...dbgBase, select: { ...baseSelect,
      scene: { select: { id: true, name: true } },
      imageTags: { select: { tag: { select: { id: true, name: true } } } } } });
    const t3 = Date.now();
    await prisma.image.findMany({ ...dbgBase, select: { ...baseSelect,
      scene: { select: { id: true, name: true } },
      imageTags: { select: { tag: { select: { id: true, name: true } } } },
      prompt: { select: { currentBody: true, _count: { select: { versions: true } } } } } });
    const t4 = Date.now();

    // ── Phase 2: prompt internals (body vs count) ───────────────────────────
    await prisma.image.findMany({ ...dbgBase, select: { ...baseSelect,
      prompt: { select: { currentBody: true } } } });
    const t5 = Date.now();
    await prisma.image.findMany({ ...dbgBase, select: { ...baseSelect,
      prompt: { select: { _count: { select: { versions: true } } } } } });
    const t6 = Date.now();

    // ── Phase 3: imageTags internals (junction only vs +tag join) ───────────
    await prisma.image.findMany({ ...dbgBase, select: { ...baseSelect,
      imageTags: { select: { imageId: true, tagId: true } } } });
    const t7 = Date.now();
    await prisma.image.findMany({ ...dbgBase, select: { ...baseSelect,
      imageTags: { select: { tag: { select: { id: true, name: true } } } } } });
    const t8 = Date.now();

    // ── Phase 4: single $queryRaw — all relations in one SQL round-trip ────
    // Comparison baseline: if this is fast, Prisma's multi-SELECT RTT is the culprit.
    // workspaceId is bound as a parameter — not logged.
    const tRaw0 = Date.now();
    const rawRows = await prisma.$queryRaw<{ id: string }[]>(
      Prisma.sql`
        SELECT
          i.id,
          i.original_name,
          i.width_px,
          i.height_px,
          i.thumbnail_path,
          i.preview_path,
          i.is_favorite,
          i.rating,
          i.created_at,
          s.id   AS scene_id,
          s.name AS scene_name,
          COALESCE(
            JSON_AGG(DISTINCT JSONB_BUILD_OBJECT('id', t.id, 'name', t.name))
              FILTER (WHERE t.id IS NOT NULL),
            '[]'::json
          ) AS tags,
          p.current_body  AS prompt_body,
          COUNT(DISTINCT pv.id)::int AS prompt_version_count
        FROM images i
        LEFT JOIN scenes       s  ON s.id       = i.scene_id
        LEFT JOIN image_tags   it ON it.image_id = i.id
        LEFT JOIN tags         t  ON t.id        = it.tag_id
        LEFT JOIN prompts      p  ON p.image_id  = i.id
        LEFT JOIN prompt_versions pv ON pv.prompt_id = p.id
        WHERE i.workspace_id = ${workspace.id}
          AND i.status       = 'ACTIVE'
          AND i.deleted_at   IS NULL
        GROUP BY i.id, s.id, s.name, p.current_body
        ORDER BY i.created_at DESC, i.id DESC
        LIMIT ${limit + 1}
      `,
    );
    const tRaw1 = Date.now();

    console.log(JSON.stringify({
      tag: "gallery.images.debugDb",
      // Phase 1 — cumulative staged
      dbBaseMs:   t1 - t0,
      dbSceneMs:  t2 - t1,
      dbTagsMs:   t3 - t2,
      dbPromptMs: t4 - t3,
      dbFullMs:   t4 - t0,
      // Phase 2 — prompt internals
      dbPromptBodyMs:  t5 - t4,
      dbPromptCountMs: t6 - t5,
      // Phase 3 — imageTags internals
      dbImageTagsOnlyMs: t7 - t6,
      dbTagsJoinMs:      t8 - t7,
      // Phase 4 — single queryRaw (1 SQL vs Prisma multi-SELECT)
      dbRawGalleryMs: tRaw1 - tRaw0,
      rawRowCount: rawRows.length,
      rowCount: limit,
    }));
  }

  // ── Internal shape shared by both query paths ──────────────────────────
  type PageImage = {
    id: string;
    originalName: string;
    widthPx: number | null;
    heightPx: number | null;
    thumbnailPath: string | null;
    previewPath: string | null;
    isFavorite: boolean;
    rating: number | null;
    createdAt: Date;
    scene: { id: string; name: string } | null;
    tags: { id: string; name: string }[];
    promptBody: string | null;
    promptVersionCount: number;
  };

  // ── Query path selection ────────────────────────────────────────────────
  // Raw path: first page, default sort, no filters.
  // Everything else (cursor / filters / sort=asc) falls back to Prisma.
  const useRawPath =
    cursor === null &&
    sort === "desc" &&
    q === "" &&
    sceneId === null &&
    tagId === null &&
    personId === null &&
    favorite === null;

  let rawImages: PageImage[];
  let queryMode: "raw" | "prisma";

  if (useRawPath) {
    // ── $queryRaw path: single SQL round-trip with LEFT JOINs ─────────────
    // ~4× faster than Prisma multi-SELECT for uncached first pages.
    // workspaceId bound as parameter — never interpolated into SQL string.
    await prisma.$queryRaw`SELECT 1`;
    perf.mark("dbPingMs");
    type RawRow = {
      id: string;
      original_name: string;
      width_px: number | null;
      height_px: number | null;
      thumbnail_path: string | null;
      preview_path: string | null;
      is_favorite: boolean;
      rating: number | null;
      created_at: Date;
      scene_id: string | null;
      scene_name: string | null;
      tags: unknown; // JSON_AGG → parsed by pg driver as JS array
      prompt_body: string | null;
      prompt_version_count: number | bigint;
    };

    const rows = await prisma.$queryRaw<RawRow[]>(
      Prisma.sql`
        SELECT
          i.id,
          i.original_name,
          i.width_px,
          i.height_px,
          i.thumbnail_path,
          i.preview_path,
          i.is_favorite,
          i.rating,
          i.created_at,
          s.id                                                      AS scene_id,
          s.name                                                    AS scene_name,
          COALESCE(
            JSON_AGG(DISTINCT JSONB_BUILD_OBJECT('id', t.id, 'name', t.name))
              FILTER (WHERE t.id IS NOT NULL),
            '[]'::json
          )                                                         AS tags,
          p.current_body                                            AS prompt_body,
          CAST(COUNT(DISTINCT pv.id) AS integer)                    AS prompt_version_count
        FROM images i
        LEFT JOIN scenes          s  ON s.id        = i.scene_id
        LEFT JOIN image_tags      it ON it.image_id  = i.id
        LEFT JOIN tags            t  ON t.id         = it.tag_id
        LEFT JOIN prompts         p  ON p.image_id   = i.id
        LEFT JOIN prompt_versions pv ON pv.prompt_id = p.id
        WHERE i.workspace_id = ${workspace.id}
          AND i.status       = 'ACTIVE'
          AND i.deleted_at   IS NULL
        GROUP BY i.id, s.id, s.name, p.current_body
        ORDER BY i.created_at DESC, i.id DESC
        LIMIT ${limit + 1}
      `,
    );
    perf.mark("dbRawMainMs");
    queryMode = "raw";

    rawImages = rows.map((row) => {
      const tags = Array.isArray(row.tags)
        ? (row.tags as { id: string; name: string }[])
        : (JSON.parse(row.tags as string) as { id: string; name: string }[]);
      return {
        id: row.id,
        originalName: row.original_name,
        widthPx: row.width_px,
        heightPx: row.height_px,
        thumbnailPath: row.thumbnail_path,
        previewPath: row.preview_path,
        isFavorite: row.is_favorite,
        rating: row.rating,
        createdAt: row.created_at,
        scene: row.scene_id ? { id: row.scene_id, name: row.scene_name! } : null,
        tags,
        promptBody: row.prompt_body,
        promptVersionCount: Number(row.prompt_version_count),
      };
    });
  } else {
    // ── Prisma path: cursor / filters / sort=asc ───────────────────────────
    const prismaRows = await prisma.image.findMany({
      where,
      orderBy: [{ createdAt: sort }, { id: sort }],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
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
        prompt: {
          select: {
            currentBody: true,
            _count: { select: { versions: true } },
          },
        },
      },
    });
    perf.mark("dbFindManyMs");
    queryMode = "prisma";

    rawImages = prismaRows.map((img) => ({
      id: img.id,
      originalName: img.originalName,
      widthPx: img.widthPx,
      heightPx: img.heightPx,
      thumbnailPath: img.thumbnailPath,
      previewPath: img.previewPath,
      isFavorite: img.isFavorite,
      rating: img.rating,
      createdAt: img.createdAt,
      scene: img.scene,
      tags: img.imageTags.map((t) => t.tag),
      promptBody: img.prompt?.currentBody ?? null,
      promptVersionCount: img.prompt?._count?.versions ?? 0,
    }));
  }

  const hasMore = rawImages.length > limit;
  const page = hasMore ? rawImages.slice(0, limit) : rawImages;
  const nextCursor = hasMore ? page[page.length - 1].id : null;
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
      tags: img.tags,
      promptSnippet: img.promptBody?.slice(0, 80) ?? null,
      promptVersionCount: img.promptVersionCount,
      thumbnailUrl: thumbnailUrl ?? fallbackUrl,
    };
  });
  perf.mark("serializeMs");

  const sceneCount  = page.filter((img) => img.scene).length;
  const tagCount    = page.reduce((n, img) => n + img.tags.length, 0);
  const promptCount = page.filter((img) => img.promptBody !== null).length;

  const workspaceCacheStats = getWorkspaceCacheStats();

  perf.end({
    imageCount: page.length,
    hasMore,
    queryMode,
    // Auth user cache (Redis TTL 60s)
    authUserCacheSource,
    authUserCacheHit: authUserCacheSource !== "miss",
    // Auth cookie diagnostics (?debugAuth=1 only)
    ...(debugAuth ? {
      authCookieNameFound,
      authCookieChunkCount,
      authRawSessionLength,
      authTokenAvailable,
      authTokenHashAvailable,
      authCookieParseMode,
      authUserCacheWriteAttempted,
      authUserCacheWriteOk,
    } : {}),
    sharedCacheEnabled: workspaceCacheStats.sharedCacheEnabled,
    cacheInstanceId: workspaceCacheStats.instanceId,
    workspaceCacheSource,
    workspaceCacheMemSize: workspaceCacheStats.memSize,
    hasQuery: q.length > 0,
    hasCursor: cursor !== null,
    hasTagFilter: !!tagId,
    hasPersonFilter: !!personId,
    hasSceneFilter: !!sceneId,
    hasFavoriteFilter: favorite !== null,
    sort,
    limit,
    sceneCount,
    tagCount,
    promptCount,
    urlCacheSize: urlCacheStats.size,
    urlCacheShared: urlCacheStats.sharedCacheEnabled,
    dbUrlMode,
    dbHostRegionHint,
  });

  return ok({ images: withUrls, nextCursor });
}
