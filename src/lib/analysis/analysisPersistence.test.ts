import { describe, it, expect } from "vitest";
import { isAnalysisCached, planPersistence } from "@/lib/analysis/analysisPersistence";
import type { AnalyzePromptResult } from "@/lib/analysis/analyzePromptCore";

describe("isAnalysisCached", () => {
  const H = "a".repeat(64);
  it("force → never cached", () => {
    expect(isAnalysisCached({ existing: { status: "DONE", promptHash: H }, currentHasPrompt: true, currentPromptHash: H, force: true })).toBe(false);
  });
  it("no existing → not cached", () => {
    expect(isAnalysisCached({ existing: null, currentHasPrompt: true, currentPromptHash: H, force: false })).toBe(false);
  });
  it("has prompt: DONE + matching hash → cached", () => {
    expect(isAnalysisCached({ existing: { status: "DONE", promptHash: H }, currentHasPrompt: true, currentPromptHash: H, force: false })).toBe(true);
  });
  it("has prompt: DONE + different hash → not cached (prompt changed)", () => {
    expect(isAnalysisCached({ existing: { status: "DONE", promptHash: "b".repeat(64) }, currentHasPrompt: true, currentPromptHash: H, force: false })).toBe(false);
  });
  it("has prompt: FAILED → not cached (retry)", () => {
    expect(isAnalysisCached({ existing: { status: "FAILED", promptHash: H }, currentHasPrompt: true, currentPromptHash: H, force: false })).toBe(false);
  });
  it("no prompt: existing SKIPPED_NO_PROMPT → cached", () => {
    expect(isAnalysisCached({ existing: { status: "SKIPPED_NO_PROMPT", promptHash: null }, currentHasPrompt: false, currentPromptHash: null, force: false })).toBe(true);
  });
  it("no prompt: existing DONE → not cached (prompt was removed)", () => {
    expect(isAnalysisCached({ existing: { status: "DONE", promptHash: H }, currentHasPrompt: false, currentPromptHash: null, force: false })).toBe(false);
  });
});

describe("planPersistence", () => {
  it("SKIPPED_NO_PROMPT: null hash, reset PENDING, no rows", () => {
    const p = planPersistence({ status: "SKIPPED_NO_PROMPT", promptHash: null });
    expect(p.status).toBe("SKIPPED_NO_PROMPT");
    expect(p.promptHash).toBeNull();
    expect(p.resetPendingSuggestions).toBe(true);
    expect(p.suggestionRows).toEqual([]);
    expect(p.keywordsJa).toBeNull();
  });

  it("FAILED: keeps error + safeRaw, does NOT reset suggestions", () => {
    const r: AnalyzePromptResult = { status: "FAILED", promptHash: "h", error: "boom", safeRaw: { x: 1 } };
    const p = planPersistence(r);
    expect(p.status).toBe("FAILED");
    expect(p.error).toBe("boom");
    expect(p.safeRaw).toEqual({ x: 1 });
    expect(p.resetPendingSuggestions).toBe(false);
    expect(p.suggestionRows).toEqual([]);
  });

  it("FAILED without safeRaw → safeRaw null", () => {
    const p = planPersistence({ status: "FAILED", promptHash: "h", error: "boom" });
    expect(p.safeRaw).toBeNull();
  });

  it("DONE: maps keywords, usage, and suggestion rows (confidence null when absent)", () => {
    const r: AnalyzePromptResult = {
      status: "DONE",
      promptHash: "h",
      tags: [{ label: "landscape", confidence: 0.9 }, { label: "mountain" }],
      keywordsJa: ["山"],
      keywordsEn: ["mountain"],
      usageCategory: "scene_reference",
      languageDetected: "en",
      safeRaw: { ok: true },
    };
    const p = planPersistence(r);
    expect(p.status).toBe("DONE");
    expect(p.promptHash).toBe("h");
    expect(p.usageCategory).toBe("scene_reference");
    expect(p.languageDetected).toBe("en");
    expect(p.keywordsJa).toEqual(["山"]);
    expect(p.keywordsEn).toEqual(["mountain"]);
    expect(p.safeRaw).toEqual({ ok: true });
    expect(p.resetPendingSuggestions).toBe(true);
    expect(p.suggestionRows).toEqual([
      { label: "landscape", confidence: 0.9 },
      { label: "mountain", confidence: null },
    ]);
  });
});
