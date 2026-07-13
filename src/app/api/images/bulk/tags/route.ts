import "server-only";

export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { getCurrentUser, getDefaultWorkspaceForUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, Errors } from "@/lib/apiResponse";
import { withWorkspaceWhere } from "@/lib/workspace/where";
import { checkUserRateLimit, rateLimitHeaders } from "@/lib/rateLimit";
import { normalizeBulkImageIds } from "@/lib/gallery/bulkImageIds";
import { normalizeManualTagName } from "@/lib/gallery/manualTagInput";

/**
 * POST /api/images/bulk/tags  (Phase 10-18B)
 *
 * Adds one manually-typed tag to MANY images at once: finds/creates the Tag
 * (workspace-scoped upsert by name, same as POST /api/images/[id]/tags) then
 * links it to every requested image via a single createMany({skipDuplicates})
 * — the same bulk-insert pattern already used by POST /api/tags/[id]/merge.
 * TagSuggestion is never touched. No taxonomy/synonym normalization is
 * applied to the name (manual input is verbatim, trimmed only).
 *
 * imageIds validation is two-tier (mirrors POST /api/uploads/apply-prompt):
 * - existence/workspace membership: all-or-nothing — any id not found in
 *   this workspace fails the WHOLE request (400), since the client's
 *   imageIds should already come from its own ACTIVE/non-deleted image list.
 * - ACTIVE + non-deleted: also all-or-nothing (stricter than apply-prompt's
 *   soft-skip) — a request naming a deleted/non-ACTIVE image is treated as
 *   the same kind of error, since it should not normally occur.
 *
 * Idempotent: re-POSTing the same (imageIds, name) is a no-op for images
 * that already have the tag (createMany skipDuplicates + response counts
 * reflect alreadyLinkedCount vs newly linked).
 *
 * Order: auth → workspace → rate limit → body validation (imageIds, name) →
 * image existence/eligibility check → $transaction(tag upsert → count
 * existing links → bulk imageTag insert).
 */
export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();

  const workspace = await getDefaultWorkspaceForUser(user.id);
  if (!workspace) return Errors.forbidden();

  const rl = await checkUserRateLimit({
    preset: "bulkTagAdd",
    userId: user.id,
    workspaceId: workspace.id,
  });
  if (!rl.allowed) return Errors.rateLimited(rateLimitHeaders(rl));

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Errors.validation("Invalid JSON");
  }

  const { imageIds: rawImageIds, name } = body as Record<string, unknown>;

  const imageIdsResult = normalizeBulkImageIds(rawImageIds);
  if (!imageIdsResult.ok) return Errors.validation(imageIdsResult.error);
  const { imageIds, requestedCount } = imageIdsResult;

  const nameResult = normalizeManualTagName(name);
  if (!nameResult.ok) return Errors.validation(nameResult.error);

  const images = await prisma.image.findMany({
    where: withWorkspaceWhere(workspace.id, { id: { in: imageIds } }),
    select: { id: true, status: true, deletedAt: true },
  });
  if (images.length !== imageIds.length) {
    return Errors.validation("Some imageIds were not found in this workspace");
  }

  const eligibleImageIds = images
    .filter((img) => img.status === "ACTIVE" && img.deletedAt === null)
    .map((img) => img.id);
  if (eligibleImageIds.length !== imageIds.length) {
    return Errors.validation("Some imageIds are deleted or not ACTIVE");
  }

  const targetCount = eligibleImageIds.length;

  const { tag, alreadyLinkedCount, createdLinkCount } = await prisma.$transaction(async (tx) => {
    const tag = await tx.tag.upsert({
      where: { workspaceId_name: { workspaceId: workspace.id, name: nameResult.name } },
      create: { workspaceId: workspace.id, name: nameResult.name },
      update: {},
      select: { id: true, name: true },
    });

    const alreadyLinkedCount = await tx.imageTag.count({
      where: { tagId: tag.id, imageId: { in: eligibleImageIds } },
    });

    const created = await tx.imageTag.createMany({
      data: eligibleImageIds.map((imageId) => ({
        imageId,
        tagId: tag.id,
        workspaceId: workspace.id,
      })),
      skipDuplicates: true,
    });

    return { tag, alreadyLinkedCount, createdLinkCount: created.count };
  });

  return ok({
    tag,
    requestedCount,
    targetCount,
    linkedCount: alreadyLinkedCount + createdLinkCount,
    alreadyLinkedCount,
    createdLinkCount,
  });
}
