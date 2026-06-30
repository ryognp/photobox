import "server-only";

export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { prisma } from "@/lib/prisma";

const BUCKET = "photobox-private";

// ─── helpers ────────────────────────────────────────────────────────────────

function safeErr(err: unknown) {
  if (!err || typeof err !== "object") return { message: String(err) };
  const e = err as Record<string, unknown>;
  return {
    name: (e.name as string) ?? null,
    message: (e.message as string) ?? null,
    code: (e.code as string) ?? null,
    status: (e.status as number) ?? null,
    statusCode: (e.statusCode as number) ?? null,
    clientVersion: (e.clientVersion as string) ?? null,
  };
}

// ─── stage A: env / admin client init ───────────────────────────────────────

function checkAdminEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    supabaseUrlPresent: !!url,
    supabaseUrlHost: url ? new URL(url).hostname : null,
    serviceRoleKeyPresent: !!key,
    serviceRoleKeyLength: key?.length ?? 0,
    // new-format publishable keys start with sb_secret_; JWT keys start with eyJ
    serviceRoleKeyPrefix: key ? key.slice(0, 10) + "…" : null,
  };
}

function makeAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ─── stage B: storage bucket access ─────────────────────────────────────────

async function checkBucket() {
  try {
    const admin = makeAdminClient();
    const { data, error } = await admin.storage.getBucket(BUCKET);
    if (error) {
      return { ok: false, error: safeErr(error) };
    }
    return {
      ok: true,
      bucket: {
        name: data?.name ?? null,
        public: data?.public ?? null,
        fileSizeLimit: data?.file_size_limit ?? null,
      },
    };
  } catch (err) {
    return { ok: false, error: safeErr(err) };
  }
}

// ─── stage C: prisma image query ────────────────────────────────────────────

async function checkImageQuery() {
  try {
    // workspaceMember から最初の workspaceId を取得してサンプルクエリ
    const member = await prisma.workspaceMember.findFirst({
      select: { workspaceId: true },
    });

    if (!member) {
      return { ok: true, note: "no workspace_member rows found", imageCount: 0 };
    }

    const images = await prisma.image.findMany({
      where: {
        workspaceId: member.workspaceId,
        deletedAt: null,
        status: "ACTIVE",
      },
      take: 3,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        thumbnailPath: true,
        previewPath: true,
        status: true,
        createdAt: true,
      },
    });

    return {
      ok: true,
      workspaceIdPrefix: member.workspaceId.slice(0, 8) + "…",
      imageCount: images.length,
      // パス存在確認のみ (実値は返さない)
      samplePaths: images.map((img) => ({
        idPrefix: img.id.slice(0, 8) + "…",
        hasThumbnailPath: !!img.thumbnailPath,
        hasPreviewPath: !!img.previewPath,
        thumbnailPathPrefix: img.thumbnailPath ? img.thumbnailPath.slice(0, 20) + "…" : null,
        status: img.status,
        createdAt: img.createdAt,
      })),
    };
  } catch (err) {
    return { ok: false, error: safeErr(err) };
  }
}

// ─── stage D: signed URL creation ───────────────────────────────────────────

async function checkSignedUrl(thumbnailPath: string | null) {
  if (!thumbnailPath) {
    return { ok: false, note: "no thumbnailPath to test" };
  }
  try {
    const admin = makeAdminClient();
    const { data, error } = await admin.storage
      .from(BUCKET)
      .createSignedUrl(thumbnailPath, 60);

    if (error) {
      return { ok: false, error: safeErr(error) };
    }

    return {
      ok: true,
      signedUrlPresent: !!data?.signedUrl,
      // URL host のみ (トークン部分は返さない)
      signedUrlHost: data?.signedUrl ? new URL(data.signedUrl).hostname : null,
    };
  } catch (err) {
    return { ok: false, error: safeErr(err) };
  }
}

// ─── handler ────────────────────────────────────────────────────────────────

export async function GET() {
  if (process.env.ENABLE_IMAGES_DEBUG !== "true") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const runtime = {
    nodeEnv: process.env.NODE_ENV ?? null,
    vercelEnv: process.env.VERCEL_ENV ?? null,
    vercelRegion: process.env.VERCEL_REGION ?? null,
  };

  // A: env
  const adminEnv = checkAdminEnv();

  // B: storage bucket
  const bucket = await checkBucket();

  // C: image query
  const imageQuery = await checkImageQuery();

  // D: signed URL (最初の画像の thumbnailPath を使う)
  let firstThumbnailPath: string | null = null;
  if (imageQuery.ok && "samplePaths" in imageQuery && (imageQuery.samplePaths as unknown[]).length > 0) {
    // パスの prefix だけでは実使用できないので、別途取得
    try {
      const member = await prisma.workspaceMember.findFirst({
        select: { workspaceId: true },
      });
      if (member) {
        const img = await prisma.image.findFirst({
          where: { workspaceId: member.workspaceId, deletedAt: null, status: "ACTIVE" },
          select: { thumbnailPath: true },
          orderBy: { createdAt: "desc" },
        });
        firstThumbnailPath = img?.thumbnailPath ?? null;
      }
    } catch {
      // ignore, signedUrl check will note the missing path
    }
  }

  const signedUrl = await checkSignedUrl(firstThumbnailPath);

  const allOk = bucket.ok && imageQuery.ok && signedUrl.ok;

  return NextResponse.json({
    ok: allOk,
    runtime,
    adminEnv,
    bucket,
    imageQuery,
    signedUrl,
  });
}
