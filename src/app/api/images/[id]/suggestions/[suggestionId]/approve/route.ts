import "server-only";

export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, Errors } from "@/lib/apiResponse";
import { resolveWorkspaceImage } from "@/lib/images/resolveWorkspaceImage";
import { withWorkspaceWhere } from "@/lib/workspace/where";
import { checkUserRateLimit, rateLimitHeaders } from "@/lib/rateLimit";
import { decideSuggestionTransition, validateSuggestionLabel } from "@/lib/analysis/suggestionTransition";

/**
 * POST /api/images/[id]/suggestions/[suggestionId]/approve
 *
 * Approves an AI tag candidate: finds/creates the Tag (workspace-scoped),
 * attaches ImageTag, and marks the suggestion APPROVED. This is the ONLY path
 * that turns an AI suggestion into a real Tag/ImageTag — suggestions are never
 * auto-promoted elsewhere.
 *
 * Body (optional): { label?: string } — edit-and-approve. Only accepted while
 * the suggestion is PENDING (Phase 10-3 decision); editing an already-approved
 * suggestion is a 409 conflict, not a silent overwrite.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; suggestionId: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();

  const { id, suggestionId } = await params;

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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const rawLabel =
    typeof body === "object" && body !== null && "label" in body
      ? (body as { label?: unknown }).label
      : undefined;
  if (rawLabel !== undefined && typeof rawLabel !== "string") {
    return Errors.validation("label must be a string");
  }
  const labelResult = validateSuggestionLabel(rawLabel as string | undefined);
  if (!labelResult.ok) return Errors.validation(labelResult.error);
  const hasLabelEdit = rawLabel !== undefined;

  // Three-point match: id + imageId + workspaceId. A suggestionId belonging to
  // another image/workspace 404s (existence is not disclosed pre-match).
  const suggestion = await prisma.tagSuggestion.findFirst({
    where: withWorkspaceWhere(image.workspaceId, { id: suggestionId, imageId: image.id }),
    select: { id: true, label: true, status: true, approvedTagId: true },
  });
  if (!suggestion) return Errors.notFound("Suggestion not found");

  const decision = decideSuggestionTransition({
    currentStatus: suggestion.status,
    action: "approve",
    hasLabelEdit,
  });

  if (decision.kind === "conflict") return Errors.conflict(decision.reason);

  if (decision.kind === "idempotent") {
    const tag = suggestion.approvedTagId
      ? await prisma.tag.findUnique({ where: { id: suggestion.approvedTagId }, select: { id: true, name: true } })
      : null;
    return ok({ suggestion: { id: suggestion.id, status: "APPROVED" as const }, tag, alreadyApproved: true });
  }

  const finalLabel = hasLabelEdit ? labelResult.label : suggestion.label;

  const result = await prisma.$transaction(async (tx) => {
    const tag = await tx.tag.upsert({
      where: { workspaceId_name: { workspaceId: image.workspaceId, name: finalLabel } },
      create: { workspaceId: image.workspaceId, name: finalLabel },
      update: {},
      select: { id: true, name: true },
    });

    await tx.imageTag.upsert({
      where: { imageId_tagId: { imageId: image.id, tagId: tag.id } },
      create: { imageId: image.id, tagId: tag.id, workspaceId: image.workspaceId },
      update: {},
    });

    const updated = await tx.tagSuggestion.update({
      where: { id: suggestion.id },
      data: { status: "APPROVED", approvedTagId: tag.id },
      select: { id: true, status: true },
    });

    return { tag, suggestion: updated };
  });

  return ok({ suggestion: result.suggestion, tag: result.tag, alreadyApproved: false });
}
