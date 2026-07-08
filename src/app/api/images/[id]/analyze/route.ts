import "server-only";

export const dynamic = "force-dynamic";
// analyzePromptCore uses node:crypto → Node.js runtime.
export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { ok, Errors } from "@/lib/apiResponse";
import { resolveWorkspaceImage } from "@/lib/images/resolveWorkspaceImage";
import { checkUserRateLimit, rateLimitHeaders } from "@/lib/rateLimit";
import {
  analyzePromptCore,
  buildAnalysisText,
  computePromptHash,
  type AnalyzePromptResult,
} from "@/lib/analysis/analyzePromptCore";
import { PROMPT_ANALYSIS_SCHEMA_VERSION } from "@/lib/analysis/analysisSchema";
import {
  isAnalysisCached,
  planPersistence,
  type AnalysisPersistencePlan,
} from "@/lib/analysis/analysisPersistence";
import { getEffectiveJapanesePromptBody } from "@/lib/translation/translationCore";
import { getAnalysisProviderFromEnv } from "@/lib/analysis/analysisProvider";
import { sanitizeAnalysisError } from "@/lib/analysis/analysisError";
import { readAnalysisMaxInputChars, truncateAnalysisInput } from "@/lib/analysis/analysisConfig";

// source/schema version are constant. modelId is per-request (provider factory
// returns a composite provider:model:promptVersion id — Phase 10-5D).
const SOURCE = "PROMPT" as const;
const SCHEMA_VERSION = PROMPT_ANALYSIS_SCHEMA_VERSION;

function jsonOrNull(v: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return v === null || v === undefined ? Prisma.JsonNull : (v as Prisma.InputJsonValue);
}

/** Maps a persistence plan to ImageAnalysis create/update data. */
function toAnalysisData(plan: AnalysisPersistencePlan) {
  return {
    status: plan.status,
    promptHash: plan.promptHash,
    error: plan.error,
    usageCategory: plan.usageCategory,
    languageDetected: plan.languageDetected,
    rawJson: jsonOrNull(plan.raw),
    keywordsJa: jsonOrNull(plan.keywordsJa),
    keywordsEn: jsonOrNull(plan.keywordsEn),
  };
}

/** Reads the analysis row + its PENDING suggestions for the response body. */
async function readAnalysisResponse(analysisId: string) {
  const analysis = await prisma.imageAnalysis.findUnique({
    where: { id: analysisId },
    select: {
      id: true,
      status: true,
      usageCategory: true,
      keywordsJa: true,
      keywordsEn: true,
      languageDetected: true,
      error: true,
      updatedAt: true,
      suggestions: {
        where: { status: "PENDING" },
        select: { id: true, label: true, confidence: true, status: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  return analysis;
}

/**
 * POST /api/images/[id]/analyze  (?force=1)
 *
 * On-demand prompt-first analysis. The provider is resolved from env
 * (Phase 10-5D: getAnalysisProviderFromEnv — mock unless AI_ANALYSIS_ENABLED
 * and a real provider are configured; in 10-5D-1 only mock is ever "ok").
 * Persists ImageAnalysis + PENDING TagSuggestion candidates. AI results are
 * candidates only — never auto-promoted to Tags.
 *
 * Order: auth → resolveWorkspaceImage → deleted/status 404 → rate limit →
 * provider resolution → build+truncate text → hash → existing lookup →
 * cached check → (config_error → FAILED | mock/real → analyze) → persist.
 * core FAILED and config_error are returned as HTTP 200 with status:"FAILED"
 * (handled + persisted); 500 is reserved for unexpected DB/code errors.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();

  const { id } = await params;

  const resolved = await resolveWorkspaceImage({
    id,
    userId: user.id,
    select: {
      id: true,
      workspaceId: true,
      status: true,
      deletedAt: true,
      notes: true,
      prompt: {
        select: {
          currentBody: true,
          translatedBodyJa: true,
          translatedFromBodyHash: true,
          translationStatus: true,
        },
      },
    },
  });
  if (resolved.kind === "not_found") return Errors.notFound("Image not found");
  if (resolved.kind === "forbidden") return Errors.forbidden();
  const image = resolved.image;

  if (image.deletedAt !== null || image.status !== "ACTIVE") {
    return Errors.notFound("Image not found");
  }

  // Rate limit AFTER the deleted/status check, BEFORE cached check / analyze.
  const rl = await checkUserRateLimit({
    preset: "aiAnalyze",
    userId: user.id,
    workspaceId: image.workspaceId,
  });
  if (!rl.allowed) return Errors.rateLimited(rateLimitHeaders(rl));

  const force = request.nextUrl.searchParams.get("force") === "1";
  const currentBody = image.prompt?.currentBody ?? null;
  const notes = image.notes ?? null;
  // Phase 10-5C: prefer a validated Japanese translation over currentBody.
  // getEffectiveJapanesePromptBody re-checks status+hash itself — presence
  // of translatedBodyJa alone is never trusted.
  const effectiveJapaneseBody = image.prompt
    ? getEffectiveJapanesePromptBody({
        currentBody: image.prompt.currentBody,
        translatedBodyJa: image.prompt.translatedBodyJa,
        translatedFromBodyHash: image.prompt.translatedFromBodyHash,
        translationStatus: image.prompt.translationStatus,
      })
    : null;

  // Phase 10-5D: provider resolution (composite modelId), then truncate BEFORE
  // hashing so the cache key + provider input match exactly.
  const resolution = getAnalysisProviderFromEnv(process.env);
  const modelId = resolution.modelId;

  const builtText = buildAnalysisText({ currentBody, notes, effectiveJapaneseBody });
  const { text: analysisText } = truncateAnalysisInput(builtText, readAnalysisMaxInputChars(process.env));
  const hasPrompt = analysisText !== "";
  const currentHash = hasPrompt ? computePromptHash(analysisText) : null;

  const uniqueWhere = {
    imageId_source_modelId_schemaVersion: {
      imageId: image.id,
      source: SOURCE,
      modelId,
      schemaVersion: SCHEMA_VERSION,
    },
  };

  const existing = await prisma.imageAnalysis.findUnique({
    where: uniqueWhere,
    select: { id: true, status: true, promptHash: true },
  });

  if (isAnalysisCached({ existing, currentHasPrompt: hasPrompt, currentPromptHash: currentHash, force })) {
    const analysis = await readAnalysisResponse(existing!.id);
    return ok({ cached: true, analysis });
  }

  // Phase 10-5D: config_error (provider unavailable/misconfigured) is persisted
  // as a visible FAILED — never a bare HTTP 500. When there is no prompt text
  // at all it is a SKIP (the provider would never have been called anyway).
  // Cost guard / real provider call arrive in 10-5D-2.
  let result: AnalyzePromptResult;
  if (resolution.kind === "config_error") {
    result = hasPrompt
      ? { status: "FAILED", promptHash: computePromptHash(analysisText), error: sanitizeAnalysisError(resolution.error) }
      : { status: "SKIPPED_NO_PROMPT", promptHash: null };
  } else {
    result = await analyzePromptCore(
      { currentBody, notes, effectiveJapaneseBody, preparedText: analysisText },
      { provider: resolution.provider, schemaVersion: SCHEMA_VERSION },
    );
  }
  const plan = planPersistence(result);

  try {
    const analysisId = await prisma.$transaction(async (tx) => {
      const a = await tx.imageAnalysis.upsert({
        where: uniqueWhere,
        create: {
          workspaceId: image.workspaceId,
          imageId: image.id,
          source: SOURCE,
          modelId,
          schemaVersion: SCHEMA_VERSION,
          ...toAnalysisData(plan),
        },
        update: toAnalysisData(plan),
        select: { id: true },
      });

      // Re-analysis: drop PENDING suggestions, keep APPROVED/REJECTED. FAILED
      // leaves suggestions untouched.
      if (plan.resetPendingSuggestions) {
        await tx.tagSuggestion.deleteMany({ where: { analysisId: a.id, status: "PENDING" } });
      }
      if (plan.suggestionRows.length > 0) {
        await tx.tagSuggestion.createMany({
          data: plan.suggestionRows.map((r) => ({
            workspaceId: image.workspaceId,
            imageId: image.id,
            analysisId: a.id,
            label: r.label,
            confidence: r.confidence,
          })),
          skipDuplicates: true,
        });
      }
      return a.id;
    });

    const analysis = await readAnalysisResponse(analysisId);
    return ok({ cached: false, analysis });
  } catch (e) {
    // Unexpected DB/code error (NOT a core FAILED — that was persisted as 200).
    console.error("[analyze] persistence error", e instanceof Error ? e.message : String(e));
    return Errors.internal();
  }
}
