// Phase 10-11B: provider abstraction for prompt-variation generation. Mirrors
// src/lib/translation/provider.ts — a swappable vendor behind one interface,
// mock-only until an operator enables the real provider. No DB, no image bytes
// (prompt text only). Returns ONLY the generated prompt text.
import type { VariationChange } from "./types";

export interface PromptVariationProvider {
  /** "mock" | "openai". Not persisted (nothing is stored), used for budget key. */
  readonly providerId: string;
  /** provider:model:promptVersion composite (see buildVariationModelId). */
  readonly modelId: string;
  generate(originalPrompt: string, changes: VariationChange[]): Promise<{ text: string }>;
}
