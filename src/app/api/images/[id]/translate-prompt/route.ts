import "server-only";

export const dynamic = "force-dynamic";
// translationCore / openai provider use node:crypto / SDK → Node.js runtime.
export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, Errors } from "@/lib/apiResponse";
import { resolveWorkspaceImage } from "@/lib/images/resolveWorkspaceImage";
import { checkUserRateLimit, rateLimitHeaders } from "@/lib/rateLimit";
import { decideTranslationTarget, sanitizeTranslationError } from "@/lib/translation/translationCore";
import {
  getTranslationProviderFromEnv,
  isTranslationEnabled,
} from "@/lib/translation/translationProviderFactory";
import { createOpenAITranslationProvider } from "@/lib/translation/openaiTranslationProvider";
import { reserveTranslationBudget } from "@/lib/translation/translationBudget";
import {
  readTranslationMaxInputChars,
  readTranslationDailyCallLimit,
} from "@/lib/translation/translationConfig";
import {
  truncateTranslationInput,
  buildTranslationUpdateData,
  type TranslationUpdateOutcome,
} from "@/lib/translation/singleTranslationPlan";
import type { Prisma } from "@/generated/prisma/client";

/** Translation fields returned to the client (never provider raw/usage/keys). */
async function readPromptTranslation(promptId: string) {
  return prisma.prompt.findUnique({
    where: { id: promptId },
    select: {
      translatedBodyJa: true,
      translationStatus: true,
      translationProvider: true,
      translationModel: true,
      translatedAt: true,
      translationError: true,
    },
  });
}

/**
 * POST /api/images/[id]/translate-prompt   body: { force?: boolean }
 *
 * Translates a single image's prompt.currentBody into Japanese, caching the
 * result on Prompt.translatedBodyJa. The original prompt is NEVER overwritten.
 *
 * Only runs when isTranslationEnabled(env) (TRANSLATION_ENABLED=true +
 * PROVIDER=openai + key). Otherwise returns 200 { status:"disabled" } WITHOUT
 * touching the DB / budget / provider — so mock's [MOCK-JA] never reaches the
 * DB via this route. All business states are HTTP 200 with a `status`
 * discriminator; only auth/existence/rate-limit use 401/403/404/429.
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
      prompt: {
        select: {
          id: true,
          currentBody: true,
          translationStatus: true,
          translatedFromBodyHash: true,
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

  // Backstop: disabled / mock → do NOT touch DB, budget, or provider. This is
  // what keeps [MOCK-JA] out of the DB (the UI also gates on translationEnabled).
  if (!isTranslationEnabled(process.env)) {
    return ok({ status: "disabled" as const, translation: null });
  }

  if (!image.prompt) {
    return ok({ status: "no_prompt" as const, translation: null });
  }
  const prompt = image.prompt;

  const rl = await checkUserRateLimit({
    preset: "translatePrompt",
    userId: user.id,
    workspaceId: image.workspaceId,
  });
  if (!rl.allowed) return Errors.rateLimited(rateLimitHeaders(rl));

  let body: Record<string, unknown>;
  try {
    body = request.headers.get("content-length") === "0" ? {} : ((await request.json()) as Record<string, unknown>);
  } catch {
    body = {};
  }
  const force = body.force === true;

  const decision = decideTranslationTarget({
    currentBody: prompt.currentBody,
    translationStatus: prompt.translationStatus,
    translatedFromBodyHash: prompt.translatedFromBodyHash,
    force,
  });

  // Guarded update: currentBody must be unchanged since we read it, else the
  // translation is stale (原文が処理中に編集された) — do not write it.
  const now = new Date();
  const runGuardedUpdate = async (data: Prisma.PromptUpdateManyMutationInput): Promise<boolean> => {
    const res = await prisma.prompt.updateMany({
      where: { id: prompt.id, workspaceId: image.workspaceId, currentBody: prompt.currentBody },
      data,
    });
    return res.count > 0;
  };

  // Already Japanese → store verbatim, no provider / budget.
  if (decision.action === "skip_already_ja") {
    const outcome: TranslationUpdateOutcome = {
      kind: "skipped_already_ja",
      currentBody: prompt.currentBody,
      bodyHash: decision.bodyHash,
    };
    const written = await runGuardedUpdate(buildTranslationUpdateData(outcome, now));
    if (!written) return ok({ status: "stale" as const, translation: null });
    return ok({ status: "SKIPPED_ALREADY_JA" as const, translation: await readPromptTranslation(prompt.id) });
  }

  // Valid cached DONE (no force) → return existing, no provider / budget.
  if (decision.action === "skip_cached") {
    return ok({ status: "DONE" as const, cached: true, translation: await readPromptTranslation(prompt.id) });
  }

  // decision.action === "translate": resolve provider ONLY here.
  const resolution = getTranslationProviderFromEnv(process.env, { createOpenAI: createOpenAITranslationProvider });

  // isTranslationEnabled was true, so config_error is not expected; if it
  // occurs (e.g. wiring gap) persist a sanitized FAILED rather than an opaque
  // 500 — never the API key / raw error.
  if (resolution.kind === "config_error") {
    const outcome: TranslationUpdateOutcome = {
      kind: "failed",
      error: sanitizeTranslationError(resolution.error),
      providerId: resolution.providerId,
      modelId: resolution.modelId,
    };
    const written = await runGuardedUpdate(buildTranslationUpdateData(outcome, now));
    if (!written) return ok({ status: "stale" as const, translation: null });
    return ok({ status: "FAILED" as const, translation: await readPromptTranslation(prompt.id) });
  }

  const { provider } = resolution;

  // Cost guard: reserve BEFORE the provider call (provider is non-mock here).
  const budget = await reserveTranslationBudget({
    workspaceId: image.workspaceId,
    providerId: resolution.providerId,
    modelId: resolution.modelId,
    limit: readTranslationDailyCallLimit(process.env),
  });
  if (!budget.allowed) {
    const outcome: TranslationUpdateOutcome = {
      kind: "failed",
      error: sanitizeTranslationError(budget.reason),
      providerId: resolution.providerId,
      modelId: resolution.modelId,
    };
    const written = await runGuardedUpdate(buildTranslationUpdateData(outcome, now));
    if (!written) return ok({ status: "stale" as const, translation: null });
    return ok({ status: "FAILED" as const, translation: await readPromptTranslation(prompt.id) });
  }

  // Truncate ONLY the provider input; the stored hash stays full-body based.
  const { text: providerInput } = truncateTranslationInput(
    prompt.currentBody,
    readTranslationMaxInputChars(process.env),
  );

  let outcome: TranslationUpdateOutcome;
  try {
    const translated = await provider.translate(providerInput);
    outcome = {
      kind: "done",
      translatedText: translated.text,
      bodyHash: decision.bodyHash,
      providerId: resolution.providerId,
      modelId: resolution.modelId,
    };
  } catch (e) {
    outcome = {
      kind: "failed",
      error: sanitizeTranslationError(e),
      providerId: resolution.providerId,
      modelId: resolution.modelId,
    };
  }

  const written = await runGuardedUpdate(buildTranslationUpdateData(outcome, now));
  if (!written) return ok({ status: "stale" as const, translation: null });

  const translation = await readPromptTranslation(prompt.id);
  return ok(
    outcome.kind === "done"
      ? { status: "DONE" as const, translation, budget: { remaining: budget.remaining } }
      : { status: "FAILED" as const, translation },
  );
}
