// Phase 10-9C-2: real OpenAI translation provider via the Responses API.
// Mirrors src/lib/analysis/openaiProvider.ts but returns PLAIN TEXT (no JSON
// schema — a translation is free text). No "server-only" so it stays
// unit-testable with an injected mock client; the eventual route is the
// server boundary. Prompt text only — never image bytes.
//
// Returns ONLY the translated text. Raw completion, usage, tokens, request id,
// headers, API key, and metadata are never returned, logged, or persisted.
// Errors are normalized to short, safe messages.
import OpenAI from "openai";
import type { TranslationProvider } from "./provider";
import { TRANSLATION_SYSTEM_PROMPT } from "./translationSystemPrompt";

/** Minimal Responses-client surface we depend on — lets tests inject a mock. */
export interface TranslationResponsesClient {
  responses: {
    create(
      body: { model: string; instructions: string; input: string },
      options?: { signal?: AbortSignal },
    ): Promise<{ output_text: string }>;
  };
}

function createRealClient(apiKey: string): TranslationResponsesClient {
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

export type CreateOpenAITranslationProviderConfig = {
  apiKey: string;
  model: string;
  modelId: string;
  timeoutMs: number;
  /** Injected in tests; real client is built from apiKey when omitted. */
  client?: TranslationResponsesClient;
};

export function createOpenAITranslationProvider(
  config: CreateOpenAITranslationProviderConfig,
): TranslationProvider {
  const client = config.client ?? createRealClient(config.apiKey);

  return {
    providerId: "openai",
    modelId: config.modelId,
    translate: async (text: string) => {
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, config.timeoutMs);

      try {
        const res = await client.responses.create(
          { model: config.model, instructions: TRANSLATION_SYSTEM_PROMPT, input: text },
          { signal: controller.signal },
        );
        return { text: res.output_text };
      } catch (e) {
        if (timedOut) throw new Error("translation provider timeout");
        const status = (e as { status?: number } | null)?.status;
        if (status === 429) throw new Error("translation provider rate limited");
        if (typeof status === "number" && status >= 500) throw new Error("translation provider unavailable");
        throw e; // other errors → caller sanitizes via sanitizeTranslationError
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
