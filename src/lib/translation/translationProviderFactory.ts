// Phase 10-9C-2: resolves the translation provider from env. Mirrors
// src/lib/analysis/analysisProvider.ts. Returns a discriminated union (never
// throws) so the eventual route can persist a config problem as a visible
// failure rather than an opaque 500. The real OpenAI provider is injected via
// deps.createOpenAI so this module (and its unit test) avoid the openai SDK.
import type { TranslationProvider } from "./provider";
import { createMockTranslationProvider } from "./mockProvider";
import { TRANSLATION_PROMPT_VERSION, buildTranslationModelId } from "./translationModelId";
import { readTranslationTimeoutMs, resolveTranslationApiKey } from "./translationConfig";

export type TranslationProviderResolution =
  | { kind: "ok"; provider: TranslationProvider; providerId: "mock" | "openai"; modelId: string }
  | { kind: "config_error"; providerId: "openai"; modelId: string; error: string };

/** Signature of createOpenAITranslationProvider — injected so this module avoids the SDK import. */
export type CreateOpenAITranslationProvider = (config: {
  apiKey: string;
  model: string;
  modelId: string;
  timeoutMs: number;
}) => TranslationProvider;

export type TranslationProviderDeps = {
  createOpenAI?: CreateOpenAITranslationProvider;
};

type EnvLike = Record<string, string | undefined>;

/**
 * STRICT gate for exposing translation UI / running the real provider
 * (Phase 10-9C-2 decision). True ONLY when all hold:
 *   - TRANSLATION_ENABLED === "true"
 *   - TRANSLATION_PROVIDER === "openai"
 *   - a translation API key exists (TRANSLATION_OPENAI_API_KEY ?? OPENAI_API_KEY)
 * A mock provider always yields false, so the 10-9C-4 "日本語訳を追加" button is
 * never shown while translation is mock — no [MOCK-JA] can reach the prod DB.
 */
export function isTranslationEnabled(env: EnvLike): boolean {
  return (
    env.TRANSLATION_ENABLED === "true" &&
    env.TRANSLATION_PROVIDER === "openai" &&
    resolveTranslationApiKey(env) !== undefined
  );
}

function mockResolution(): TranslationProviderResolution {
  const modelId = buildTranslationModelId({ provider: "mock", model: "mock", promptVersion: TRANSLATION_PROMPT_VERSION });
  return { kind: "ok", provider: createMockTranslationProvider(modelId), providerId: "mock", modelId };
}

export function getTranslationProviderFromEnv(
  env: EnvLike,
  deps?: TranslationProviderDeps,
): TranslationProviderResolution {
  // Killswitch: unless explicitly enabled, always mock (production default).
  if (env.TRANSLATION_ENABLED !== "true") return mockResolution();

  const providerName = env.TRANSLATION_PROVIDER ?? "mock";
  if (providerName === "mock") return mockResolution();

  if (providerName === "openai") {
    const model = env.TRANSLATION_MODEL || "gpt-4o-mini";
    const modelId = buildTranslationModelId({ provider: "openai", model, promptVersion: TRANSLATION_PROMPT_VERSION });
    const apiKey = resolveTranslationApiKey(env);
    if (!apiKey) {
      return { kind: "config_error", providerId: "openai", modelId, error: "translation API key is not configured" };
    }
    if (!deps?.createOpenAI) {
      return { kind: "config_error", providerId: "openai", modelId, error: "OpenAI translation provider factory not wired" };
    }
    const timeoutMs = readTranslationTimeoutMs(env);
    return {
      kind: "ok",
      providerId: "openai",
      modelId,
      provider: deps.createOpenAI({ apiKey, model, modelId, timeoutMs }),
    };
  }

  const modelId = buildTranslationModelId({ provider: "openai", model: "unknown", promptVersion: TRANSLATION_PROMPT_VERSION });
  return { kind: "config_error", providerId: "openai", modelId, error: `Unsupported TRANSLATION_PROVIDER: ${providerName}` };
}
