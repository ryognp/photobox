import { describe, it, expect } from "vitest";
import { createMockTranslationProvider, createThrowingTranslationProvider } from "@/lib/translation/mockProvider";

describe("createMockTranslationProvider", () => {
  it("prefixes with [MOCK-JA] so callers can distinguish from a real translation", async () => {
    const provider = createMockTranslationProvider();
    const result = await provider.translate("a cute cat");
    expect(result.text).toBe("[MOCK-JA] a cute cat");
    expect(provider.providerId).toBe("mock");
    expect(provider.modelId).toBe("mock-v1");
  });
});

describe("createThrowingTranslationProvider", () => {
  it("always rejects with the given message", async () => {
    const provider = createThrowingTranslationProvider("boom");
    await expect(provider.translate("x")).rejects.toThrow("boom");
  });
});
