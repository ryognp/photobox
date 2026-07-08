// Phase 10-5D: resolves which analysis provider to use from env. Returns a
// discriminated union rather than throwing, so the route can persist a
// configuration problem as a visible ImageAnalysis FAILED (not an opaque
// HTTP 500). A config_error still carries a composite modelId so the failure
// is recorded under the same cache key the eventual success would use.
//
// 10-5D-1 scope: the real OpenAI provider does NOT exist yet (arrives in
// 10-5D-2). So AI_ANALYSIS_PROVIDER=openai — even with a key present —
// resolves to config_error here. Only mock is ever "ok" in this phase.
import type { PromptAnalysisProvider } from "./provider";
import { createMockProvider } from "./mockProvider";
import { ANALYSIS_PROMPT_VERSION, buildAnalysisModelId } from "./analysisModelId";

export type AnalysisProviderResolution =
  | { kind: "ok"; provider: PromptAnalysisProvider; providerId: "mock" | "openai" | "gemini"; modelId: string }
  | { kind: "config_error"; providerId: "openai" | "gemini"; modelId: string; error: string };

type EnvLike = Record<string, string | undefined>;

function mockResolution(): AnalysisProviderResolution {
  const modelId = buildAnalysisModelId({ provider: "mock", model: "mock", promptVersion: ANALYSIS_PROMPT_VERSION });
  return { kind: "ok", provider: createMockProvider(undefined, modelId), providerId: "mock", modelId };
}

export function getAnalysisProviderFromEnv(env: EnvLike): AnalysisProviderResolution {
  // Killswitch: unless explicitly enabled, always mock (production default).
  if (env.AI_ANALYSIS_ENABLED !== "true") return mockResolution();

  const providerName = env.AI_ANALYSIS_PROVIDER ?? "mock";

  if (providerName === "mock") return mockResolution();

  if (providerName === "openai") {
    const model = env.AI_ANALYSIS_MODEL || "gpt-4o-mini";
    const modelId = buildAnalysisModelId({ provider: "openai", model, promptVersion: ANALYSIS_PROMPT_VERSION });
    // 10-5D-1: real provider not implemented yet. Surface as config_error so it
    // persists as a visible FAILED rather than silently returning nothing.
    // (10-5D-2 replaces this branch with createOpenAIProvider, and adds the
    //  OPENAI_API_KEY-missing → config_error check.)
    return {
      kind: "config_error",
      providerId: "openai",
      modelId,
      error: "OpenAI provider is not available yet (Phase 10-5D-2)",
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
