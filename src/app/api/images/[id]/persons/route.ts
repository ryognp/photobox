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
 * POST /api/images/[id]/persons  (Phase 10-15B)
 *
 * Links a Person TO an image (creates/keeps the ImagePerson join row only).
 * The Person itself is never created/edited here — personId must reference
 * an existing Person in the same workspace as the image.
 *
 * Idempotent: 200 + { person: { id, name } } whether or not the link already
 * existed (upsert with update:{}) — a double-click or retry is a no-op.
 *
 * Order: auth → resolveWorkspaceImage → deleted/status 404 → rate limit →
 * body validation → person workspace-membership check → upsert ImagePerson.
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
    preset: "personAssignAction",
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

  const { personId } = body as Record<string, unknown>;
  if (typeof personId !== "string" || personId.trim() === "") {
    return Errors.validation("personId is required");
  }

  // Cross-workspace personId must never be linkable — this is the security
  // boundary (mirrors resolveWorkspaceImage's role for the image side).
  const person = await prisma.person.findFirst({
    where: withWorkspaceWhere(image.workspaceId, { id: personId }),
    select: { id: true, name: true },
  });
  if (!person) return Errors.validation("person not found in this workspace");

  // upsert on the composite key so a re-POST of an already-linked person is a
  // no-op (update: {}) rather than a unique-constraint error — idempotent.
  await prisma.imagePerson.upsert({
    where: { imageId_personId: { imageId: image.id, personId: person.id } },
    create: { imageId: image.id, personId: person.id, workspaceId: image.workspaceId },
    update: {},
  });

  return ok({ person });
}
