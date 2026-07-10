import { describe, it, expect, vi } from "vitest";
import {
  createOpenAITranslationProvider,
  type TranslationResponsesClient,
} from "@/lib/translation/openaiTranslationProvider";

function clientReturning(outputText: string): TranslationResponsesClient {
  return { responses: { create: vi.fn(async () => ({ output_text: outputText })) } };
}
function clientThrowing(err: unknown): TranslationResponsesClient {
  return { responses: { create: vi.fn(async () => { throw err; }) } };
}

const CFG = { apiKey: "sk-x", model: "gpt-4o-mini", modelId: "openai:gpt-4o-mini:tr-v1", timeoutMs: 20000 };

describe("createOpenAITranslationProvider", () => {
  it("returns the translated text only", async () => {
    const provider = createOpenAITranslationProvider({ ...CFG, client: clientReturning("可愛い猫") });
    expect(provider.providerId).toBe("openai");
    expect(provider.modelId).toBe("openai:gpt-4o-mini:tr-v1");
    expect(await provider.translate("a cute cat")).toEqual({ text: "可愛い猫" });
  });

  it("does not surface usage/tokens/headers even if the client returns them", async () => {
    const client: TranslationResponsesClient = {
      responses: {
        create: vi.fn(async () => ({ output_text: "訳", usage: { total_tokens: 999 }, _request_id: "req_x" }) as unknown as { output_text: string }),
      },
    };
    const provider = createOpenAITranslationProvider({ ...CFG, client });
    const result = await provider.translate("x");
    expect(result).toEqual({ text: "訳" });
    expect(JSON.stringify(result)).not.toContain("total_tokens");
    expect(JSON.stringify(result)).not.toContain("req_x");
  });

  it("HTTP 429 → 'translation provider rate limited'", async () => {
    const provider = createOpenAITranslationProvider({ ...CFG, client: clientThrowing({ status: 429 }) });
    await expect(provider.translate("x")).rejects.toThrow("translation provider rate limited");
  });

  it("HTTP 5xx → 'translation provider unavailable'", async () => {
    const provider = createOpenAITranslationProvider({ ...CFG, client: clientThrowing({ status: 503 }) });
    await expect(provider.translate("x")).rejects.toThrow("translation provider unavailable");
  });

  it("other errors rethrown unchanged (caller sanitizes)", async () => {
    const provider = createOpenAITranslationProvider({ ...CFG, client: clientThrowing({ status: 400, message: "bad" }) });
    await expect(provider.translate("x")).rejects.not.toThrow("translation provider");
  });

  it("timeout (abort) → 'translation provider timeout'", async () => {
    const client: TranslationResponsesClient = {
      responses: {
        create: (_body, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      },
    };
    const provider = createOpenAITranslationProvider({ ...CFG, timeoutMs: 5, client });
    await expect(provider.translate("x")).rejects.toThrow("translation provider timeout");
  });
});
