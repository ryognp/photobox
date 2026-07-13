import "server-only";

export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { getCurrentUser, getDefaultWorkspaceForUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, Errors } from "@/lib/apiResponse";
import { withWorkspaceWhere } from "@/lib/workspace/where";
import { checkUserRateLimit, rateLimitHeaders } from "@/lib/rateLimit";
import { normalizeBulkImageIds } from "@/lib/gallery/bulkImageIds";
import { normalizeBulkPersonName } from "@/lib/gallery/bulkPersonInput";

/**
 * POST /api/images/bulk/persons  (Phase 10-18B)
 *
 * Links one Person (found-or-created by name) to MANY images at once. Unlike
 * POST /api/images/[id]/persons (which requires an EXISTING personId and
 * never creates a Person), this bulk route combines find-or-create (same
 * upsert-by-name logic as POST /api/persons) with a bulk link — there is no
 * single-image equivalent that does both today.
 *
 * imageIds validation mirrors POST /api/images/bulk/tags: existence/workspace
 * membership and ACTIVE/non-deleted are both all-or-nothing.
 *
 * name validation uses normalizeBulkPersonName (bulk-only 40-char cap) —
 * POST /api/persons itself is unchanged and remains uncapped.
 *
 * Idempotent: re-POSTing the same (imageIds, name) is a no-op for images
 * that already have the person linked (createMany skipDuplicates).
 *
 * Order: auth → workspace → rate limit → body validation (imageIds, name) →
 * image existence/eligibility check → $transaction(person upsert → count
 * existing links → bulk imagePerson insert).
 */
export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();

  const workspace = await getDefaultWorkspaceForUser(user.id);
  if (!workspace) return Errors.forbidden();

  const rl = await checkUserRateLimit({
    preset: "bulkPersonAssign",
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

  const nameResult = normalizeBulkPersonName(name);
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

  const { person, alreadyLinkedCount, createdLinkCount } = await prisma.$transaction(async (tx) => {
    const person = await tx.person.upsert({
      where: { workspaceId_name: { workspaceId: workspace.id, name: nameResult.name } },
      create: { workspaceId: workspace.id, name: nameResult.name },
      update: {},
      select: { id: true, name: true },
    });

    const alreadyLinkedCount = await tx.imagePerson.count({
      where: { personId: person.id, imageId: { in: eligibleImageIds } },
    });

    const created = await tx.imagePerson.createMany({
      data: eligibleImageIds.map((imageId) => ({
        imageId,
        personId: person.id,
        workspaceId: workspace.id,
      })),
      skipDuplicates: true,
    });

    return { person, alreadyLinkedCount, createdLinkCount: created.count };
  });

  return ok({
    person,
    requestedCount,
    targetCount,
    linkedCount: alreadyLinkedCount + createdLinkCount,
    alreadyLinkedCount,
    createdLinkCount,
  });
}
