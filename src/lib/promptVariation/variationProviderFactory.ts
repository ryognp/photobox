// Phase 10-11B: resolves the prompt-variation provider from env. Mirrors
// src/lib/translation/translationProviderFactory.ts. Returns a discriminated
// union (never throws) so the route can surface a config problem as a visible
// FAILED rather than an opaque 500. The real OpenAI provider is injected via
// deps.createOpenAI so this module (and its unit test) avoid the openai SDK.
import type { PromptVariationProvider } from "./provider";
import { createMockVariationProvider } from "./mockProvider";
import { PROMPT_VARIATION_PROMPT_VERSION, buildVariationModelId } from "./variationModelId";
import { readVariationTimeoutMs, resolveVariationApiKey } from "./variationConfig";

export type VariationProviderResolution =
  | { kind: "ok"; provider: PromptVariationProvider; providerId: "mock" | "openai"; modelId: string }
  | { kind: "config_error"; providerId: "openai"; modelId: string; error: string };

/** Signature of createOpenAIVariationProvider — injected so this module avoids the SDK import. */
export type CreateOpenAIVariationProvider = (config: {
  apiKey: string;
  model: string;
  modelId: string;
  timeoutMs: number;
}) => PromptVariationProvider;

export type VariationProviderDeps = {
  createOpenAI?: CreateOpenAIVariationProvider;
};

type EnvLike = Record<string, string | undefined>;

/**
 * STRICT gate for exposing the prompt-variation UI (Phase 10-11C) / running the
 * real provider. True ONLY when all hold:
 *   - PROMPT_VARIATION_ENABLED === "true"
 *   - PROMPT_VARIATION_PROVIDER === "openai"
 *   - an API key exists (PROMPT_VARIATION_OPENAI_API_KEY ?? OPENAI_API_KEY)
 * A mock provider always yields false, so the future UI button is never shown
 * while the provider is mock — no mock output can be mistaken for a real one.
 */
export function isVariationEnabled(env: EnvLike): boolean {
  return (
    env.PROMPT_VARIATION_ENABLED === "true" &&
    env.PROMPT_VARIATION_PROVIDER === "openai" &&
    resolveVariationApiKey(env) !== undefined
  );
}

function mockResolution(): VariationProviderResolution {
  const modelId = buildVariationModelId({ provider: "mock", model: "mock", promptVersion: PROMPT_VARIATION_PROMPT_VERSION });
  return { kind: "ok", provider: createMockVariationProvider(modelId), providerId: "mock", modelId };
}

export function getVariationProviderFromEnv(
  env: EnvLike,
  deps?: VariationProviderDeps,
): VariationProviderResolution {
  // Killswitch: unless explicitly enabled, always mock (production default).
  if (env.PROMPT_VARIATION_ENABLED !== "true") return mockResolution();

  const providerName = env.PROMPT_VARIATION_PROVIDER ?? "mock";
  if (providerName === "mock") return mockResolution();

  if (providerName === "openai") {
    const model = env.PROMPT_VARIATION_MODEL || "gpt-4o-mini";
    const modelId = buildVariationModelId({ provider: "openai", model, promptVersion: PROMPT_VARIATION_PROMPT_VERSION });
    const apiKey = resolveVariationApiKey(env);
    if (!apiKey) {
      return { kind: "config_error", providerId: "openai", modelId, error: "prompt variation API key is not configured" };
    }
    if (!deps?.createOpenAI) {
      return { kind: "config_error", providerId: "openai", modelId, error: "OpenAI prompt variation provider factory not wired" };
    }
    const timeoutMs = readVariationTimeoutMs(env);
    return {
      kind: "ok",
      providerId: "openai",
      modelId,
      provider: deps.createOpenAI({ apiKey, model, modelId, timeoutMs }),
    };
  }

  const modelId = buildVariationModelId({ provider: "openai", model: "unknown", promptVersion: PROMPT_VARIATION_PROMPT_VERSION });
  return { kind: "config_error", providerId: "openai", modelId, error: `Unsupported PROMPT_VARIATION_PROVIDER: ${providerName}` };
}
