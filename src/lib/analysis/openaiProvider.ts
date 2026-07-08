// Phase 10-5D-2: real OpenAI analysis provider via the Responses API with
// Structured Outputs. No "server-only" marker so it stays unit-testable with
// an injected mock client (the analyze route, which imports this, is the
// server boundary). Prompt-text only — never image bytes.
//
// Returns ONLY the structured JSON body. Raw completion, usage, tokens,
// request id, headers, API key, and metadata are never returned, logged, or
// persisted. Errors are normalized to short, safe messages.
import OpenAI from "openai";
import type { PromptAnalysisProvider } from "./provider";
import { promptAnalysisJsonSchema } from "./analysisSchema";
import { ANALYSIS_SYSTEM_PROMPT } from "./analysisPrompt";

type JsonSchemaFormat = {
  type: "json_schema";
  name: string;
  schema: Record<string, unknown>;
  strict: boolean;
};

/** Minimal Responses-client surface we depend on — lets tests inject a mock. */
export interface AnalysisResponsesClient {
  responses: {
    create(
      body: { model: string; instructions: string; input: string; text: { format: JsonSchemaFormat } },
      options?: { signal?: AbortSignal },
    ): Promise<{ output_text: string }>;
  };
}

function createRealClient(apiKey: string): AnalysisResponsesClient {
  const client = new OpenAI({ apiKey });
  return {
    responses: {
      create: async (body, options) => {
        const res = await client.responses.create(
          {
            model: body.model,
            instructions: body.instructions,
            input: body.input,
            text: { format: body.text.format },
          },
          options,
        );
        // Convenience aggregate of the model's text output. We deliberately
        // read nothing else off the response (no usage/tokens/headers/ids).
        return { output_text: res.output_text };
      },
    },
  };
}

export type CreateOpenAIProviderConfig = {
  apiKey: string;
  model: string;
  modelId: string;
  timeoutMs: number;
  /** Injected in tests; real client is built from apiKey when omitted. */
  client?: AnalysisResponsesClient;
};

export function createOpenAIProvider(config: CreateOpenAIProviderConfig): PromptAnalysisProvider {
  const client = config.client ?? createRealClient(config.apiKey);
  const format: JsonSchemaFormat = {
    type: "json_schema",
    name: promptAnalysisJsonSchema.name,
    schema: promptAnalysisJsonSchema.schema as unknown as Record<string, unknown>,
    strict: promptAnalysisJsonSchema.strict,
  };

  return {
    modelId: config.modelId,
    analyze: async (text: string) => {
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, config.timeoutMs);

      try {
        const res = await client.responses.create(
          { model: config.model, instructions: ANALYSIS_SYSTEM_PROMPT, input: text, text: { format } },
          { signal: controller.signal },
        );
        // Structured JSON body only. analyzePromptCore re-validates via zod.
        return JSON.parse(res.output_text);
      } catch (e) {
        if (timedOut) throw new Error("analysis provider timeout");
        const status = (e as { status?: number } | null)?.status;
        if (status === 429) throw new Error("analysis provider rate limited");
        if (typeof status === "number" && status >= 500) throw new Error("analysis provider unavailable");
        throw e; // other errors → analyzePromptCore sanitizes the message
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
