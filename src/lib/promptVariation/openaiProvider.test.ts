import { describe, it, expect, vi } from "vitest";
import { createOpenAIVariationProvider, type VariationResponsesClient } from "@/lib/promptVariation/openaiProvider";

function clientReturning(outputText: string): VariationResponsesClient {
  return { responses: { create: vi.fn(async () => ({ output_text: outputText })) } };
}
function clientThrowing(err: unknown): VariationResponsesClient {
  return { responses: { create: vi.fn(async () => { throw err; }) } };
}

const CFG = { apiKey: "sk-x", model: "gpt-4o-mini", modelId: "openai:gpt-4o-mini:prompt-var-v1", timeoutMs: 20000 };

describe("createOpenAIVariationProvider", () => {
  it("returns ONLY the trimmed output_text (no raw/usage/etc.)", async () => {
    const provider = createOpenAIVariationProvider({ ...CFG, client: clientReturning("  new prompt text  ") });
    expect(provider.providerId).toBe("openai");
    expect(provider.modelId).toBe("openai:gpt-4o-mini:prompt-var-v1");
    const r = await provider.generate("original", ["pose"]);
    expect(r).toEqual({ text: "new prompt text" });
    // only the text field is present — no usage/tokens/id leaked
    expect(Object.keys(r)).toEqual(["text"]);
  });

  it("empty output → throws (route maps to FAILED)", async () => {
    const provider = createOpenAIVariationProvider({ ...CFG, client: clientReturning("   ") });
    await expect(provider.generate("original", ["pose"])).rejects.toThrow(/empty output/);
  });

  it("normalizes 429 → safe rate-limited message", async () => {
    const provider = createOpenAIVariationProvider({ ...CFG, client: clientThrowing({ status: 429 }) });
    await expect(provider.generate("x", ["pose"])).rejects.toThrow("prompt variation provider rate limited");
  });

  it("normalizes 5xx → safe unavailable message", async () => {
    const provider = createOpenAIVariationProvider({ ...CFG, client: clientThrowing({ status: 503 }) });
    await expect(provider.generate("x", ["pose"])).rejects.toThrow("prompt variation provider unavailable");
  });
});
