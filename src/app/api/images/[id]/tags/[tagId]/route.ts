import "server-only";

export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, Errors } from "@/lib/apiResponse";
import { resolveWorkspaceImage } from "@/lib/images/resolveWorkspaceImage";
import { withWorkspaceWhere } from "@/lib/workspace/where";
import { checkUserRateLimit, rateLimitHeaders } from "@/lib/rateLimit";

/**
 * DELETE /api/images/[id]/tags/[tagId]  (Phase 10-6B)
 *
 * Removes a tag FROM an image (deletes the ImageTag join row only). The Tag
 * itself is never deleted, and no other image's ImageTag is touched — so this
 * works for both approved-AI tags and normal tags without side effects.
 *
 * Idempotent: 200 + { removed: boolean }. removed:false when the ImageTag was
 * already absent (double-click, cross-workspace tagId, other image's tagId).
 * Image-level not_found/forbidden/deleted still follow the usual 404/403.
 *
 * Order: auth → resolveWorkspaceImage → deleted/status 404 → rate limit →
 * delete ImageTag (workspace + image scoped).
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; tagId: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();

  const { id, tagId } = await params;

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
    preset: "tagSuggestionAction",
    userId: user.id,
    workspaceId: image.workspaceId,
  });
  if (!rl.allowed) return Errors.rateLimited(rateLimitHeaders(rl));

  // deleteMany (not delete) so a missing/cross-workspace/other-image row is a
  // no-op (count 0) rather than a throw — idempotent. workspaceId + imageId in
  // the where are the security boundary; Tag itself is never referenced.
  const res = await prisma.imageTag.deleteMany({
    where: withWorkspaceWhere(image.workspaceId, { imageId: image.id, tagId }),
  });

  return ok({ removed: res.count > 0, imageId: image.id, tagId });
}
