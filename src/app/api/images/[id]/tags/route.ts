import "server-only";

export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, Errors } from "@/lib/apiResponse";
import { resolveWorkspaceImage } from "@/lib/images/resolveWorkspaceImage";
import { checkUserRateLimit, rateLimitHeaders } from "@/lib/rateLimit";
import { normalizeManualTagName } from "@/lib/gallery/manualTagInput";

/**
 * POST /api/images/[id]/tags  (Phase 10-16B)
 *
 * Adds a manually-typed tag to an image: finds/creates the Tag (workspace-
 * scoped upsert by name) and attaches ImageTag. This is a second path onto
 * the same Tag/ImageTag tables the AI-suggestion approve route writes to
 * (tx.tag.upsert + tx.imageTag.upsert) — TagSuggestion is never touched here,
 * and no provenance/source distinction is recorded (Phase 10-16A decision:
 * deferred until teacher-data use is concrete).
 *
 * No taxonomy/synonym normalization is applied to the name — a manually-
 * typed tag is used verbatim (trimmed only), unlike AI-suggestion labels.
 *
 * Idempotent: 200 + { tag: { id, name } } whether or not the image already
 * had this tag (upsert with update:{}) — a re-POST of the same name is a
 * no-op on the ImageTag side (and reuses the existing Tag row by name).
 *
 * Order: auth → resolveWorkspaceImage → deleted/status 404 → rate limit →
 * body validation → transaction (tag upsert → imageTag upsert).
 */
export async function POST(
  request: NextRequest,
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

  if (image.deletedAt !== null || image.status !== "ACTIVE") {
    return Errors.notFound("Image not found");
  }

  const rl = await checkUserRateLimit({
    preset: "manualTagAdd",
    userId: user.id,
    workspaceId: image.workspaceId,
  });
  if (!rl.allowed) return Errors.rateLimited(rateLimitHeaders(rl));

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Errors.validation("Invalid JSON");
  }

  const { name } = body as Record<string, unknown>;
  const nameResult = normalizeManualTagName(name);
  if (!nameResult.ok) return Errors.validation(nameResult.error);

  // Same tx.tag.upsert + tx.imageTag.upsert pattern as the AI-suggestion
  // approve route — TagSuggestion is never created/read/updated on this path.
  const tag = await prisma.$transaction(async (tx) => {
    const tag = await tx.tag.upsert({
      where: { workspaceId_name: { workspaceId: image.workspaceId, name: nameResult.name } },
      create: { workspaceId: image.workspaceId, name: nameResult.name },
      update: {},
      select: { id: true, name: true },
    });

    await tx.imageTag.upsert({
      where: { imageId_tagId: { imageId: image.id, tagId: tag.id } },
      create: { imageId: image.id, tagId: tag.id, workspaceId: image.workspaceId },
      update: {},
    });

    return tag;
  });

  return ok({ tag });
}
