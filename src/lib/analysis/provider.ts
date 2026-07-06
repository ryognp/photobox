/**
 * Provider abstraction for prompt-text analysis (Phase 10-1).
 * The provider returns raw JSON; validation/normalization happens in
 * analyzePromptCore via the zod schema. This keeps the vendor (OpenAI now,
 * Gemini later) swappable behind one interface. No DB, no image bytes.
 */
export interface PromptAnalysisProvider {
  /** Model identifier stored on ImageAnalysis.modelId (e.g. "gpt-4o-mini", "mock"). */
  readonly modelId: string;
  /** Analyze the prompt text; returns the provider's structured output (unvalidated). */
  analyze(text: string): Promise<unknown>;
}
