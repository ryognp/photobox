/**
 * Provider abstraction for Japanese translation (Phase 10-5B). Mirrors
 * src/lib/analysis/provider.ts's PromptAnalysisProvider — swappable vendor
 * behind one interface, mock-only until a later phase explicitly approves a
 * real provider (OpenAI/Gemini). No DB, no image bytes.
 */
export interface TranslationProvider {
  /** e.g. "mock" | "openai" | "gemini". Stored on Prompt.translationProvider. */
  readonly providerId: string;
  /** e.g. "mock-v1", "gpt-4o-mini". Stored on Prompt.translationModel. */
  readonly modelId: string;
  translate(text: string): Promise<{ text: string }>;
}
