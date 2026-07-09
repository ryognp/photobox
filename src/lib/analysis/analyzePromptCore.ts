// Pure prompt-analysis orchestration (Phase 10-1). No DB, no server-only, no
// image bytes. The provider (DI) returns raw JSON; this validates it, strips
// person-attribute terms (defense-in-depth), normalizes, and returns a result
// object. It NEVER throws — failures become { status: "FAILED" }. Persistence
// and rate limiting live in the route layer (Phase 10-2).
import { createHash } from "node:crypto";
import type { PromptAnalysisProvider } from "./provider";
import { promptAnalysisSchema, filterAttributeTerms, type UsageCategory } from "./analysisSchema";
import { sanitizeAnalysisError } from "./analysisError";
import { refineTagCandidates } from "./tagTaxonomy";

export type AnalyzePromptInput = {
  currentBody: string | null;
  notes: string | null;
  /**
   * Phase 10-5C: the caller's pre-validated Japanese translation of
   * currentBody (see getEffectiveJapanesePromptBody — status+hash checked
   * there, NOT here). When present and non-empty, used in place of
   * currentBody; currentBody remains the fallback when this is null/absent.
   */
  effectiveJapaneseBody?: string | null;
  /**
   * Phase 10-5D: pre-built (and possibly truncated) analysis text. When
   * provided, it is used verbatim as the text to hash and send to the
   * provider — the route builds + truncates it once so the promptHash,
   * cache key, and the text the provider sees all match. When absent, the
   * text is rebuilt from the fields above via buildAnalysisText.
   */
  preparedText?: string | null;
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
      // Phase 10-5D: the SANITIZED (attribute-filtered, deduped, normalized)
      // structured output — NOT the raw provider output. This is what gets
      // stored in ImageAnalysis.rawJson, so no un-filtered person-attribute
      // terms ever reach the DB.
      safeRaw: unknown;
    }
  | { status: "FAILED"; promptHash: string | null; error: string; safeRaw?: unknown };

function normalize(s: string | null): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Builds the analyzed text from body + notes (JA original often lives in
 * notes). `effectiveJapaneseBody` (Phase 10-5C, pre-validated by the caller
 * via getEffectiveJapanesePromptBody) takes priority over currentBody when
 * present and non-empty; currentBody is the fallback. Non-empty parts are
 * joined with a single space; empty result means "no prompt".
 */
export function buildAnalysisText(input: AnalyzePromptInput): string {
  const body = normalize(input.effectiveJapaneseBody ?? null) || normalize(input.currentBody);
  const parts = [body, normalize(input.notes)].filter(Boolean);
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
  // Phase 10-5D: use the route-prepared (truncated) text verbatim when given,
  // so hash/cache-key/provider-input all match; otherwise rebuild from fields.
  const text = input.preparedText != null ? input.preparedText : buildAnalysisText(input);

  // No prompt text at all → skip (provider is never called).
  if (text === "") {
    return { status: "SKIPPED_NO_PROMPT", promptHash: null };
  }

  const promptHash = computePromptHash(text);

  let raw: unknown;
  try {
    raw = await deps.provider.analyze(text);
  } catch (e) {
    // Phase 10-5D: sanitize so a real provider's error (possible secrets /
    // huge payloads) never reaches ImageAnalysis.error or the API response.
    return {
      status: "FAILED",
      promptHash,
      error: sanitizeAnalysisError(e),
    };
  }

  const parsed = promptAnalysisSchema.safeParse(raw);
  if (!parsed.success) {
    // Phase 10-5D: do NOT persist the raw (schema-invalid, hence un-filterable)
    // output — it cannot be safety-filtered, so it never reaches the DB.
    return { status: "FAILED", promptHash, error: "schema_validation_failed" };
  }

  const out = parsed.data;

  // Step 1 (safety, defense-in-depth): strip person-attribute terms.
  const attributeFiltered = out.tags
    .map((t) => ({ label: t.label.trim(), confidence: t.confidence }))
    .filter((t) => t.label !== "" && filterAttributeTerms([t.label]).length > 0);
  // Step 2 (Phase 10-5E, quality/granularity): synonym-normalize, drop banned
  // & out-of-vocabulary, dedupe, category-priority sort, mood cap, 8-item cap.
  // Provider-independent so mock and OpenAI outputs are refined identically.
  const tags = refineTagCandidates(attributeFiltered);
  const keywordsJa = filterAttributeTerms(out.keywords_ja.map((k) => k.trim()));
  const keywordsEn = filterAttributeTerms(out.keywords_en.map((k) => k.trim()));

  // Phase 10-5D: safeRaw is built from the FILTERED values (never the provider
  // raw), so ImageAnalysis.rawJson matches what the UI/API shows and carries
  // no un-filtered person-attribute terms.
  const safeRaw = {
    tags,
    keywords_ja: keywordsJa,
    keywords_en: keywordsEn,
    usage_category: out.usage_category,
    language_detected: out.language_detected,
  };

  return {
    status: "DONE",
    promptHash,
    tags,
    keywordsJa,
    keywordsEn,
    usageCategory: out.usage_category,
    languageDetected: out.language_detected,
    safeRaw,
  };
}
