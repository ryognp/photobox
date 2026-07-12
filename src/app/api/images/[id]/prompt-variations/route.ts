import "server-only";

export const dynamic = "force-dynamic";
// openai provider uses the SDK → Node.js runtime.
export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { ok, Errors } from "@/lib/apiResponse";
import { resolveWorkspaceImage } from "@/lib/images/resolveWorkspaceImage";
import { checkUserRateLimit, rateLimitHeaders } from "@/lib/rateLimit";
import {
  validateChanges,
  truncateVariationInput,
  sanitizeVariationError,
} from "@/lib/promptVariation/variationCore";
import {
  getVariationProviderFromEnv,
  isVariationEnabled,
} from "@/lib/promptVariation/variationProviderFactory";
import { createOpenAIVariationProvider } from "@/lib/promptVariation/openaiProvider";
import { reserveVariationBudget } from "@/lib/promptVariation/variationBudget";
import { readVariationMaxInputChars, readVariationDailyCallLimit } from "@/lib/promptVariation/variationConfig";

/**
 * POST /api/images/[id]/prompt-variations   body: { changes: VariationChange[] }
 *
 * Generates a NEW image-generation prompt from the image's existing
 * prompt.currentBody, changing only the selected dimensions (pose / outfit /
 * expression / place / mood_time). The result is NOT persisted — the original
 * prompt is never modified, no PromptVersion is created, nothing is written to
 * the DB. The caller (Phase 10-11C UI) shows the text in a modal and copies it.
 *
 * Only runs when isVariationEnabled(env) (ENABLED=true + PROVIDER=openai +
 * key). Otherwise returns 200 { status:"disabled" } WITHOUT touching budget or
 * provider. All business states are HTTP 200 with a `status` discriminator;
 * only auth/existence/validation/rate-limit use 401/403/404/400/429.
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
      prompt: { select: { id: true, currentBody: true } },
    },
  });
  if (resolved.kind === "not_found") return Errors.notFound("Image not found");
  if (resolved.kind === "forbidden") return Errors.forbidden();
  const image = resolved.image;

  if (image.deletedAt !== null || image.status !== "ACTIVE") {
    return Errors.notFound("Image not found");
  }

  if (!image.prompt) {
    return ok({ status: "no_prompt" as const, variation: null });
  }
  const prompt = image.prompt;

  // Parse + validate `changes` before touching the provider/budget.
  let body: Record<string, unknown>;
  try {
    body = request.headers.get("content-length") === "0" ? {} : ((await request.json()) as Record<string, unknown>);
  } catch {
    body = {};
  }
  const validation = validateChanges(body.changes);
  if (!validation.ok) return Errors.validation(validation.error);
  const changes = validation.changes;

  // Backstop: disabled / mock → do NOT touch budget or provider. The UI also
  // gates on variationEnabled (Phase 10-11C).
  if (!isVariationEnabled(process.env)) {
    return ok({ status: "disabled" as const, variation: null });
  }

  const rl = await checkUserRateLimit({
    preset: "promptVariation",
    userId: user.id,
    workspaceId: image.workspaceId,
  });
  if (!rl.allowed) return Errors.rateLimited(rateLimitHeaders(rl));

  const resolution = getVariationProviderFromEnv(process.env, { createOpenAI: createOpenAIVariationProvider });

  // isVariationEnabled was true, so config_error is not expected; if it occurs
  // (e.g. wiring gap) return a sanitized FAILED rather than an opaque 500 —
  // never the API key / raw error. Nothing is persisted.
  if (resolution.kind === "config_error") {
    return ok({ status: "FAILED" as const, variation: null, error: sanitizeVariationError(resolution.error) });
  }
  const { provider } = resolution;

  // Cost guard: reserve BEFORE the provider call (provider is non-mock here).
  const budget = await reserveVariationBudget({
    workspaceId: image.workspaceId,
    providerId: resolution.providerId,
    modelId: resolution.modelId,
    limit: readVariationDailyCallLimit(process.env),
  });
  if (!budget.allowed) {
    return ok({ status: "FAILED" as const, variation: null, error: sanitizeVariationError(budget.reason) });
  }

  // Truncate ONLY the provider input (nothing is persisted).
  const { text: providerInput } = truncateVariationInput(prompt.currentBody, readVariationMaxInputChars(process.env));

  try {
    const generated = await provider.generate(providerInput, changes);
    return ok({
      status: "DONE" as const,
      variation: { text: generated.text },
    });
  } catch (e) {
    return ok({ status: "FAILED" as const, variation: null, error: sanitizeVariationError(e) });
  }
}
