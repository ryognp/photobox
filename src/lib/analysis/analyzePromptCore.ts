// Pure prompt-analysis orchestration (Phase 10-1). No DB, no server-only, no
// image bytes. The provider (DI) returns raw JSON; this validates it, strips
// person-attribute terms (defense-in-depth), normalizes, and returns a result
// object. It NEVER throws — failures become { status: "FAILED" }. Persistence
// and rate limiting live in the route layer (Phase 10-2).
import { createHash } from "node:crypto";
import type { PromptAnalysisProvider } from "./provider";
import { promptAnalysisSchema, filterAttributeTerms, type UsageCategory } from "./analysisSchema";

export type AnalyzePromptInput = {
  currentBody: string | null;
  notes: string | null;
};

export type AnalyzePromptDeps = {
  provider: PromptAnalysisProvider;
  schemaVersion: string;
};

export type AnalyzePromptResult =
  | { status: "SKIPPED_NO_PROMPT"; promptHash: null }
  | {
      status: "DONE";
      promptHash: string;
      tags: { label: string; confidence?: number }[];
      keywordsJa: string[];
      keywordsEn: string[];
      usageCategory: UsageCategory;
      languageDetected: string;
      raw: unknown;
    }
  | { status: "FAILED"; promptHash: string | null; error: string; raw?: unknown };

function normalize(s: string | null): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Builds the analyzed text from currentBody + notes (JA original often lives in
 * notes). Non-empty parts are joined with a single space; empty result means
 * "no prompt".
 */
export function buildAnalysisText(input: AnalyzePromptInput): string {
  const parts = [normalize(input.currentBody), normalize(input.notes)].filter(Boolean);
  return parts.join(" ");
}

/** SHA-256 hex of the analyzed input; used for re-analysis change detection. */
export function computePromptHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function analyzePromptCore(
  input: AnalyzePromptInput,
  deps: AnalyzePromptDeps,
): Promise<AnalyzePromptResult> {
  const text = buildAnalysisText(input);

  // No prompt text at all → skip (provider is never called).
  if (text === "") {
    return { status: "SKIPPED_NO_PROMPT", promptHash: null };
  }

  const promptHash = computePromptHash(text);

  let raw: unknown;
  try {
    raw = await deps.provider.analyze(text);
  } catch (e) {
    return {
      status: "FAILED",
      promptHash,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  const parsed = promptAnalysisSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "FAILED", promptHash, error: "schema_validation_failed", raw };
  }

  const out = parsed.data;

  // Defense-in-depth: strip person-attribute terms from tags & keywords.
  // Then dedupe tag labels case-insensitively — TagSuggestion is unique on
  // (analysisId, label), so duplicate labels from the provider would collide
  // on persistence (Phase 10-2). First occurrence wins.
  const seenLabels = new Set<string>();
  const tags = out.tags
    .map((t) => ({ label: t.label.trim(), confidence: t.confidence }))
    .filter((t) => t.label !== "" && filterAttributeTerms([t.label]).length > 0)
    .filter((t) => {
      const key = t.label.toLowerCase();
      if (seenLabels.has(key)) return false;
      seenLabels.add(key);
      return true;
    })
    .map((t) => ({ label: t.label, ...(t.confidence !== undefined ? { confidence: t.confidence } : {}) }));
  const keywordsJa = filterAttributeTerms(out.keywords_ja.map((k) => k.trim()));
  const keywordsEn = filterAttributeTerms(out.keywords_en.map((k) => k.trim()));

  return {
    status: "DONE",
    promptHash,
    tags,
    keywordsJa,
    keywordsEn,
    usageCategory: out.usage_category,
    languageDetected: out.language_detected,
    raw,
  };
}
