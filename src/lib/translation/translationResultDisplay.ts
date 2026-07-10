// Phase 10-9C-4: client-safe display mapping for the single-image translate
// result. NO node:crypto / server-only import (unlike translationCore.ts) so it
// can be used directly inside the DetailPanel client component. Pure + testable.
import type { TranslatePromptResult } from "@/lib/gallery/imagesClient";

export type TranslationDisplayMessage = { text: string; tone: "ok" | "info" | "error" };

/**
 * Maps a translate-prompt API result to a short status line for the UI, or null
 * when nothing should be shown. The translated text itself is displayed from
 * `prompt.effectiveTranslatedBodyJa` (server-computed) — never from here.
 */
export function describeTranslationResult(result: TranslatePromptResult): TranslationDisplayMessage | null {
  switch (result.status) {
    case "DONE":
      return {
        text: result.cached ? "日本語訳を表示しました（キャッシュ済み）" : "日本語訳を作成しました",
        tone: "ok",
      };
    case "SKIPPED_ALREADY_JA":
      return { text: "このプロンプトは既に日本語です", tone: "info" };
    case "FAILED":
      return {
        text: `翻訳に失敗しました: ${result.translation?.translationError ?? "不明なエラー"}`,
        tone: "error",
      };
    case "disabled":
      // Defensive: the button is gated on translationEnabled, so this normally
      // never reaches the client.
      return { text: "翻訳は現在利用できません", tone: "info" };
    case "stale":
      return {
        text: "原文が変更されました。最新の状態に更新してから再度お試しください",
        tone: "info",
      };
    case "no_prompt":
      // Defensive: the section is not rendered without a prompt.
      return null;
  }
}
