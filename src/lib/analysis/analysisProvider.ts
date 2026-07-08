// Phase 10-5D: resolves which analysis provider to use from env. Returns a
// discriminated union rather than throwing, so the route can persist a
// configuration problem as a visible ImageAnalysis FAILED (not an opaque
// HTTP 500). A config_error still carries a composite modelId so the failure
// is recorded under the same cache key the eventual success would use.
//
// The real OpenAI provider is injected via deps.createOpenAI (Phase 10-5D-2)
// rather than statically imported, so this module (and its unit test) stay
// free of the openai SDK import — the analyze route wires the real factory.
import type { PromptAnalysisProvider } from "./provider";
import { createMockProvider } from "./mockProvider";
import { ANALYSIS_PROMPT_VERSION, buildAnalysisModelId } from "./analysisModelId";
import { readAnalysisTimeoutMs } from "./analysisConfig";

export type AnalysisProviderResolution =
  | { kind: "ok"; provider: PromptAnalysisProvider; providerId: "mock" | "openai" | "gemini"; modelId: string }
  | { kind: "config_error"; providerId: "openai" | "gemini"; modelId: string; error: string };

/** Signature of createOpenAIProvider — injected so this module avoids the SDK import. */
export type CreateOpenAIProvider = (config: {
  apiKey: string;
  model: string;
  modelId: string;
  timeoutMs: number;
}) => PromptAnalysisProvider;

export type AnalysisProviderDeps = {
  createOpenAI?: CreateOpenAIProvider;
};

type EnvLike = Record<string, string | undefined>;

function mockResolution(): AnalysisProviderResolution {
  const modelId = buildAnalysisModelId({ provider: "mock", model: "mock", promptVersion: ANALYSIS_PROMPT_VERSION });
  return { kind: "ok", provider: createMockProvider(undefined, modelId), providerId: "mock", modelId };
}

export function getAnalysisProviderFromEnv(env: EnvLike, deps?: AnalysisProviderDeps): AnalysisProviderResolution {
  // Killswitch: unless explicitly enabled, always mock (production default).
  if (env.AI_ANALYSIS_ENABLED !== "true") return mockResolution();

  const providerName = env.AI_ANALYSIS_PROVIDER ?? "mock";

  if (providerName === "mock") return mockResolution();

  if (providerName === "openai") {
    const model = env.AI_ANALYSIS_MODEL || "gpt-4o-mini";
    const modelId = buildAnalysisModelId({ provider: "openai", model, promptVersion: ANALYSIS_PROMPT_VERSION });
    const apiKey = env.OPENAI_API_KEY;
    if (!apiKey) {
      return { kind: "config_error", providerId: "openai", modelId, error: "OPENAI_API_KEY is not configured" };
    }
    if (!deps?.createOpenAI) {
      // Should not happen in the route (it always wires the factory); guards
      // against a caller forgetting to inject it.
      return { kind: "config_error", providerId: "openai", modelId, error: "OpenAI provider factory not wired" };
    }
    const timeoutMs = readAnalysisTimeoutMs(env);
    return {
      kind: "ok",
      providerId: "openai",
      modelId,
      provider: deps.createOpenAI({ apiKey, model, modelId, timeoutMs }),
    };
  }

  if (providerName === "gemini") {
    const model = env.AI_ANALYSIS_MODEL || "gemini";
    const modelId = buildAnalysisModelId({ provider: "gemini", model, promptVersion: ANALYSIS_PROMPT_VERSION });
    return { kind: "config_error", providerId: "gemini", modelId, error: "Gemini provider is not supported" };
  }

  // Unknown provider value.
  const modelId = buildAnalysisModelId({ provider: "openai", model: "unknown", promptVersion: ANALYSIS_PROMPT_VERSION });
  return {
    kind: "config_error",
    providerId: "openai",
    modelId,
    error: `Unsupported AI_ANALYSIS_PROVIDER: ${providerName}`,
  };
}
