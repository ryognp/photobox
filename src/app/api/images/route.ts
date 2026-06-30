import "server-only";

import { NextRequest } from "next/server";
import { getCurrentUser, getDefaultWorkspaceForUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { ok, Errors } from "@/lib/apiResponse";

const BUCKET = "photobox-private";
const THUMB_EXPIRY = 900; // 15min
const LIMIT_MAX = 100;
const LIMIT_DEFAULT = 48;

async function signedUrl(path: string | null, expiry: number): Promise<string | null> {
  if (!path) return null;
  const { data, error } = await supabaseAdmin.storage
    .from(BUCKET)
    .createSignedUrl(path, expiry);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();

  const workspace = await getDefaultWorkspaceForUser(user.id);
  if (!workspace) return Errors.forbidden();

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

  const hasMore = images.length > limit;
  const page = hasMore ? images.slice(0, limit) : images;
  const nextCursor = hasMore ? page[page.length - 1].id : null;

  const withUrls = await Promise.all(
    page.map(async (img) => {
      const thumbnailUrl = await signedUrl(img.thumbnailPath, THUMB_EXPIRY);
      const fallbackUrl = thumbnailUrl
        ? null
        : await signedUrl(img.previewPath, THUMB_EXPIRY);
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
    }),
  );

  return ok({ images: withUrls, nextCursor });
}
