import "server-only";

export const dynamic = "force-dynamic";
// reserveTranslationTargets uses $queryRaw + node:crypto (via translationCore) → Node.js runtime.
export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { getCurrentUser, getDefaultWorkspaceForUserCached } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, Errors } from "@/lib/apiResponse";
import { checkUserRateLimit, rateLimitHeaders } from "@/lib/rateLimit";
import {
  clampBatchLimit,
  validateBatchOptions,
  summarizeBatchOutcomes,
  TRANSLATION_BATCH_CONCURRENCY,
  type BatchItemOutcome,
} from "@/lib/translation/batchPlan";
import {
  reserveTranslationTargets,
  buildTranslationCandidateWhere,
} from "@/lib/translation/reserveTranslationTargets";
import { decideTranslationTarget, sanitizeTranslationError } from "@/lib/translation/translationCore";
import { createMockTranslationProvider } from "@/lib/translation/mockProvider";
import { mapLimit } from "@/lib/translation/mapLimit";

// Phase 10-5B: mock provider only. Real OpenAI/Gemini is a later phase
// (explicit approval required — see photobox-workflow skill).
const provider = createMockTranslationProvider();

const TRANSLATION_PENDING_STUCK_MINUTES = 10;

function pendingStuckBefore(): Date {
  return new Date(Date.now() - TRANSLATION_PENDING_STUCK_MINUTES * 60 * 1000);
}

/**
 * POST /api/prompts/translate-batch
 *
 * Bulk-translates English-only Prompt.currentBody into Japanese, caching the
 * result on Prompt.translatedBodyJa (mock provider only — Phase 10-5B). This
 * endpoint NEVER accepts an imageId/promptId list; the only scope it accepts
 * is "the caller's own default workspace", so a request can never touch
 * another workspace's Prompts.
 *
 * Order: auth → workspace membership (getDefaultWorkspaceForUserCached) →
 * body validation → rate limit → reserve (FOR UPDATE SKIP LOCKED, in a
 * transaction) → translate each reserved row (bounded concurrency) → guarded
 * final update per row → remaining count.
 */
export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();

  const { workspace } = await getDefaultWorkspaceForUserCached(user.id);
  if (!workspace) return Errors.forbidden();

  let body: Record<string, unknown>;
  try {
    body = request.headers.get("content-length") === "0" ? {} : ((await request.json()) as Record<string, unknown>);
  } catch {
    return Errors.validation("Invalid JSON");
  }

  const dryRun = body.dryRun === true;
  const force = body.force === true;
  const retryFailedOnly = body.retryFailedOnly === true;

  const optionsCheck = validateBatchOptions({ force, retryFailedOnly });
  if (!optionsCheck.ok) return Errors.validation(optionsCheck.message);

  const limit = clampBatchLimit(body.limit);

  const rl = await checkUserRateLimit({
    preset: "translationBatch",
    userId: user.id,
    workspaceId: workspace.id,
  });
  if (!rl.allowed) return Errors.rateLimited(rateLimitHeaders(rl));

  const stuckBefore = pendingStuckBefore();

  if (dryRun) {
    const candidateCount = await prisma.prompt.count({
      where: buildTranslationCandidateWhere({
        workspaceId: workspace.id,
        force,
        retryFailedOnly,
        pendingStuckBefore: stuckBefore,
      }),
    });
    return ok({
      workspaceId: workspace.id,
      dryRun: true,
      candidateCount,
      remaining: candidateCount,
    });
  }

  const reserved = await prisma.$transaction((tx) =>
    reserveTranslationTargets({
      tx,
      workspaceId: workspace.id,
      limit,
      force,
      retryFailedOnly,
      pendingStuckBefore: stuckBefore,
    }),
  );

  const outcomes = await mapLimit(reserved, TRANSLATION_BATCH_CONCURRENCY, async (item): Promise<BatchItemOutcome> => {
    const decision = decideTranslationTarget({
      currentBody: item.currentBody,
      translationStatus: item.previousStatus,
      translatedFromBodyHash: item.previousTranslatedFromBodyHash,
      force,
    });

    if (decision.action === "skip_already_ja") {
      const res = await prisma.prompt.updateMany({
        where: { id: item.id, workspaceId: item.workspaceId, translationStatus: "PENDING", currentBody: item.currentBody },
        data: {
          translationStatus: "SKIPPED_ALREADY_JA",
          translatedBodyJa: item.currentBody,
          translatedFromBodyHash: decision.bodyHash,
          translationProvider: null,
          translationModel: null,
          translatedAt: new Date(),
          translationStartedAt: null,
          translationError: null,
        },
      });
      if (res.count === 0) return { imageId: item.imageId, status: "STALE_SKIPPED" };
      return { imageId: item.imageId, status: "SKIPPED_ALREADY_JA" };
    }

    if (decision.action === "skip_cached") {
      // Reachable only if the eligibility rule above ever changes to admit a
      // still-valid DONE row; unstick it back to DONE without re-translating.
      await prisma.prompt.updateMany({
        where: { id: item.id, workspaceId: item.workspaceId, translationStatus: "PENDING" },
        data: { translationStatus: "DONE", translationStartedAt: null, translationError: null },
      });
      return { imageId: item.imageId, status: "DONE" };
    }

    try {
      const translated = await provider.translate(item.currentBody);
      const res = await prisma.prompt.updateMany({
        where: { id: item.id, workspaceId: item.workspaceId, translationStatus: "PENDING", currentBody: item.currentBody },
        data: {
          translationStatus: "DONE",
          translatedBodyJa: translated.text,
          translatedFromBodyHash: decision.bodyHash,
          translationProvider: provider.providerId,
          translationModel: provider.modelId,
          translatedAt: new Date(),
          translationStartedAt: null,
          translationError: null,
        },
      });
      if (res.count === 0) return { imageId: item.imageId, status: "STALE_SKIPPED" };
      return { imageId: item.imageId, status: "DONE" };
    } catch (e) {
      const error = sanitizeTranslationError(e);
      const res = await prisma.prompt.updateMany({
        where: { id: item.id, workspaceId: item.workspaceId, translationStatus: "PENDING", currentBody: item.currentBody },
        data: {
          translationStatus: "FAILED",
          translationProvider: provider.providerId,
          translationModel: provider.modelId,
          translationStartedAt: null,
          translationError: error,
        },
      });
      if (res.count === 0) return { imageId: item.imageId, status: "STALE_SKIPPED" };
      return { imageId: item.imageId, status: "FAILED", error };
    }
  });

  const summary = summarizeBatchOutcomes(
    outcomes.map((r) => (r.status === "fulfilled" ? r.value : { imageId: "unknown", status: "FAILED" as const, error: sanitizeTranslationError(r.reason) })),
  );

  const remaining = await prisma.prompt.count({
    where: buildTranslationCandidateWhere({
      workspaceId: workspace.id,
      force,
      retryFailedOnly,
      pendingStuckBefore: stuckBefore,
    }),
  });

  return ok({
    workspaceId: workspace.id,
    dryRun: false,
    ...summary,
    remaining,
  });
}
