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
 * DELETE /api/images/[id]/persons/[personId]  (Phase 10-15B)
 *
 * Removes a Person FROM an image (deletes the ImagePerson join row only).
 * The Person itself is never deleted, and no other image's ImagePerson is
 * touched.
 *
 * Idempotent: 200 + { personId, removed: boolean }. removed:false when the
 * ImagePerson was already absent (double-click, cross-workspace personId,
 * other image's personId). Image-level not_found/forbidden/deleted still
 * follow the usual 404/403.
 *
 * Order: auth → resolveWorkspaceImage → deleted/status 404 → rate limit →
 * delete ImagePerson (workspace + image scoped).
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; personId: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();

  const { id, personId } = await params;

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
    preset: "personAssignAction",
    userId: user.id,
    workspaceId: image.workspaceId,
  });
  if (!rl.allowed) return Errors.rateLimited(rateLimitHeaders(rl));

  // deleteMany (not delete) so a missing/cross-workspace/other-image row is a
  // no-op (count 0) rather than a throw — idempotent. workspaceId + imageId in
  // the where are the security boundary; Person itself is never referenced.
  const res = await prisma.imagePerson.deleteMany({
    where: withWorkspaceWhere(image.workspaceId, { imageId: image.id, personId }),
  });

  return ok({ removed: res.count > 0, personId });
}
