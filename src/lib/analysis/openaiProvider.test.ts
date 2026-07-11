import { describe, it, expect, vi } from "vitest";
import { createOpenAIProvider, type AnalysisResponsesClient } from "@/lib/analysis/openaiProvider";

function clientReturning(outputText: string): AnalysisResponsesClient {
  return { responses: { create: vi.fn(async () => ({ output_text: outputText })) } };
}
function clientThrowing(err: unknown): AnalysisResponsesClient {
  return { responses: { create: vi.fn(async () => { throw err; }) } };
}

const CFG = { apiKey: "sk-x", model: "gpt-4o-mini", modelId: "openai:gpt-4o-mini:ja-tags-v5", timeoutMs: 20000 };

describe("createOpenAIProvider", () => {
  it("returns the parsed JSON body only (modelId is the composite id)", async () => {
    const body = { tags: [{ label: "猫", confidence: 0.9 }], keywords_ja: ["猫"], keywords_en: [], usage_category: "other", language_detected: "ja" };
    const provider = createOpenAIProvider({ ...CFG, client: clientReturning(JSON.stringify(body)) });
    expect(provider.modelId).toBe("openai:gpt-4o-mini:ja-tags-v5");
    const result = await provider.analyze("a cat");
    expect(result).toEqual(body);
  });

  it("does not surface usage/tokens/headers even if the client returns them", async () => {
    // The provider reads only output_text; extra fields on the response are ignored.
    const body = { tags: [], keywords_ja: [], keywords_en: [], usage_category: "other", language_detected: "ja" };
    const client: AnalysisResponsesClient = {
      responses: {
        create: vi.fn(async () => ({ output_text: JSON.stringify(body), usage: { total_tokens: 999 }, _request_id: "req_x" }) as unknown as { output_text: string }),
      },
    };
    const provider = createOpenAIProvider({ ...CFG, client });
    const result = await provider.analyze("x");
    expect(result).toEqual(body);
    expect(JSON.stringify(result)).not.toContain("total_tokens");
    expect(JSON.stringify(result)).not.toContain("req_x");
  });

  it("HTTP 429 → 'analysis provider rate limited'", async () => {
    const provider = createOpenAIProvider({ ...CFG, client: clientThrowing({ status: 429 }) });
    await expect(provider.analyze("x")).rejects.toThrow("analysis provider rate limited");
  });

  it("HTTP 5xx → 'analysis provider unavailable'", async () => {
    const provider = createOpenAIProvider({ ...CFG, client: clientThrowing({ status: 503 }) });
    await expect(provider.analyze("x")).rejects.toThrow("analysis provider unavailable");
  });

  it("other errors are rethrown unchanged (analyzePromptCore sanitizes them)", async () => {
    const provider = createOpenAIProvider({ ...CFG, client: clientThrowing({ status: 400, message: "bad request" }) });
    await expect(provider.analyze("x")).rejects.not.toThrow("analysis provider");
  });

  it("timeout (abort) → 'analysis provider timeout'", async () => {
    // Client that never resolves until aborted, so the internal timer fires.
    const client: AnalysisResponsesClient = {
      responses: {
        create: (_body, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      },
    };
    const provider = createOpenAIProvider({ ...CFG, timeoutMs: 5, client });
    await expect(provider.analyze("x")).rejects.toThrow("analysis provider timeout");
  });
});
