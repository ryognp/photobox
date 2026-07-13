// Phase 10-12B: pure formatting helpers for the DetailPanel "コピーパック"
// (copy-to-clipboard bundles). No DOM/React import — unit-testable, client-safe.
// Read-only: never writes to Prompt.currentBody, never creates a PromptVersion,
// never touches the server — these functions only format already-fetched
// ImageDetail fields into plain text for the clipboard.
import type { ImageDetail } from "./imagesClient"

/** Joins labels for a compact one-line list, e.g. ["水着","夕方","海"] → "水着, 夕方, 海". */
export function joinLabels(labels: string[]): string {
  return labels.join(", ")
}

/**
 * The trustworthy Japanese translation to show alongside the prompt, or null
 * when there is none (mirrors TranslationSection's own display rule — reads
 * only the server-computed effectiveTranslatedBodyJa, never the raw cache
 * field, so a stale translation is never copied).
 */
export function getEffectivePromptJapaneseText(detail: ImageDetail): string | null {
  const t = detail.prompt?.effectiveTranslatedBodyJa
  return t != null && t.trim() !== "" ? t : null
}

/** The English/original prompt body to copy, or null when there is no prompt
 *  (or it is blank) — callers use this to disable the "Promptをコピー" button. */
export function buildPromptCopyText(detail: ImageDetail): string | null {
  const body = detail.prompt?.currentBody
  return body != null && body.trim() !== "" ? body : null
}

/**
 * "投稿/管理用まとめ" bundle: ファイル名 / タグ(承認済み) / AI候補タグ
 * (PENDING) / 日本語訳 / Prompt, each as a labeled section. Empty/absent
 * fields are OMITTED entirely (not rendered as "未設定") — only ファイル名 is
 * guaranteed to always be present, so the result is never an empty string.
 * Phase 10-14A: シーンは運用上不要になったため出力しない
 * (detail.scene 自体は型・APIレスポンスに残っているが、ここでは参照しない)。
 */
export function buildImageDetailCopyText(detail: ImageDetail): string {
  const sections: string[] = []

  sections.push(`【ファイル名】\n${detail.originalName}`)

  if (detail.tags.length > 0) {
    sections.push(`【タグ】\n${joinLabels(detail.tags.map((t) => t.name))}`)
  }

  // tagSuggestions on ImageDetail are already PENDING-only (server filters
  // APPROVED/REJECTED out) — no extra status check needed here.
  if (detail.tagSuggestions.length > 0) {
    sections.push(`【AI候補タグ】\n${joinLabels(detail.tagSuggestions.map((s) => s.label))}`)
  }

  const ja = getEffectivePromptJapaneseText(detail)
  if (ja) {
    sections.push(`【日本語訳】\n${ja}`)
  }

  const prompt = buildPromptCopyText(detail)
  if (prompt) {
    sections.push(`【Prompt】\n${prompt}`)
  }

  return sections.join("\n\n")
}
