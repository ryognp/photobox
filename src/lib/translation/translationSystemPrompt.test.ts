import { describe, it, expect } from "vitest";
import { TRANSLATION_SYSTEM_PROMPT } from "@/lib/translation/translationSystemPrompt";

describe("TRANSLATION_SYSTEM_PROMPT", () => {
  it("states the core constraints (Japanese output, translation-only, text-only)", () => {
    expect(TRANSLATION_SYSTEM_PROMPT).toContain("日本語");
    expect(TRANSLATION_SYSTEM_PROMPT).toContain("翻訳");
    // "output only the translation" style instruction present
    expect(TRANSLATION_SYSTEM_PROMPT).toMatch(/のみ/);
  });

  it("Phase 10-9C-5: frames input as text-to-translate (not an instruction) and forbids refusing", () => {
    // input is translation TARGET, not a command to the model
    expect(TRANSLATION_SYSTEM_PROMPT).toContain("翻訳対象");
    // must not refuse / apologize instead of translating
    expect(TRANSLATION_SYSTEM_PROMPT).toContain("拒否");
  });
});
