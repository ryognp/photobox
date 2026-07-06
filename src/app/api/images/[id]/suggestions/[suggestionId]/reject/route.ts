import "server-only";

export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, Errors } from "@/lib/apiResponse";
import { resolveWorkspaceImage } from "@/lib/images/resolveWorkspaceImage";
import { withWorkspaceWhere } from "@/lib/workspace/where";
import { checkUserRateLimit, rateLimitHeaders } from "@/lib/rateLimit";
import { decideSuggestionTransition } from "@/lib/analysis/suggestionTransition";

/**
 * POST /api/images/[id]/suggestions/[suggestionId]/reject
 *
 * Rejects an AI tag candidate. Never touches Tag/ImageTag — rejection only
 * updates the suggestion's own status.
 */
export async function POST(
  _request: NextRequest,
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

  const suggestion = await prisma.tagSuggestion.findFirst({
    where: withWorkspaceWhere(image.workspaceId, { id: suggestionId, imageId: image.id }),
    select: { id: true, status: true },
  });
  if (!suggestion) return Errors.notFound("Suggestion not found");

  const decision = decideSuggestionTransition({
    currentStatus: suggestion.status,
    action: "reject",
    hasLabelEdit: false,
  });

  if (decision.kind === "conflict") return Errors.conflict(decision.reason);

  if (decision.kind === "idempotent") {
    return ok({ suggestion: { id: suggestion.id, status: "REJECTED" as const }, alreadyRejected: true });
  }

  const updated = await prisma.tagSuggestion.update({
    where: { id: suggestion.id },
    data: { status: "REJECTED" },
    select: { id: true, status: true },
  });

  return ok({ suggestion: updated, alreadyRejected: false });
}
