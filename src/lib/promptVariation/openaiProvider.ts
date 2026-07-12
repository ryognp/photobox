// Phase 10-11B: real OpenAI prompt-variation provider via the Responses API.
// Mirrors src/lib/translation/openaiTranslationProvider.ts — plain text output
// (a rewritten prompt is free text). No "server-only" so it stays unit-testable
// with an injected mock client; the route is the server boundary. Prompt text
// only — never image bytes.
//
// Returns ONLY the generated prompt text. Raw completion, usage, tokens,
// request id, headers, API key, and metadata are never returned, logged, or
// persisted. Errors are normalized to short, safe messages.
import OpenAI from "openai";
import type { PromptVariationProvider } from "./provider";
import type { VariationChange } from "./types";
import { PROMPT_VARIATION_SYSTEM_PROMPT, buildVariationInput } from "./variationPrompt";

/** Minimal Responses-client surface we depend on — lets tests inject a mock. */
export interface VariationResponsesClient {
  responses: {
    create(
      body: { model: string; instructions: string; input: string },
      options?: { signal?: AbortSignal },
    ): Promise<{ output_text: string }>;
  };
}

function createRealClient(apiKey: string): VariationResponsesClient {
  const client = new OpenAI({ apiKey });
  return {
    responses: {
      create: async (body, options) => {
        const res = await client.responses.create(
          { model: body.model, instructions: body.instructions, input: body.input },
          options,
        );
        // Read nothing but the aggregated text output (no usage/tokens/ids/headers).
        return { output_text: res.output_text };
      },
    },
  };
}

export type CreateOpenAIVariationProviderConfig = {
  apiKey: string;
  model: string;
  modelId: string;
  timeoutMs: number;
  /** Injected in tests; real client is built from apiKey when omitted. */
  client?: VariationResponsesClient;
};

export function createOpenAIVariationProvider(
  config: CreateOpenAIVariationProviderConfig,
): PromptVariationProvider {
  const client = config.client ?? createRealClient(config.apiKey);

  return {
    providerId: "openai",
    modelId: config.modelId,
    generate: async (originalPrompt: string, changes: VariationChange[]) => {
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, config.timeoutMs);

      try {
        const res = await client.responses.create(
          {
            model: config.model,
            instructions: PROMPT_VARIATION_SYSTEM_PROMPT,
            input: buildVariationInput(originalPrompt, changes),
          },
          { signal: controller.signal },
        );
        const text = (res.output_text ?? "").trim();
        // Empty output → treat as a failure (caller maps to FAILED). Never
        // return an empty variation as if it were a valid result.
        if (text === "") throw new Error("prompt variation provider returned empty output");
        return { text };
      } catch (e) {
        if (timedOut) throw new Error("prompt variation provider timeout");
        const status = (e as { status?: number } | null)?.status;
        if (status === 429) throw new Error("prompt variation provider rate limited");
        if (typeof status === "number" && status >= 500) throw new Error("prompt variation provider unavailable");
        throw e; // other errors → caller sanitizes via sanitizeVariationError
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
