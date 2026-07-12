"use client"

import { useState } from "react"
import { makeFavoritePromptItem, type FavoritePromptItem } from "@/lib/gallery/favoritePrompts"
import type { VariationChange } from "@/lib/gallery/imagesClient"

interface PromptVariationModalProps {
  text: string
  onClose: () => void
  /** Phase 10-12C: optional favorite-save context. When sourceImageId /
   *  sourceImageName are both provided, an "お気に入りに保存" button is shown.
   *  The modal never writes to localStorage itself — it only builds the item
   *  and delegates persistence to onFavoriteSave (owned by DetailPanel, which
   *  also drives the "お気に入りプロンプト" list display). */
  sourceImageId?: string
  sourceImageName?: string
  changes?: VariationChange[]
  onFavoriteSave?: (item: FavoritePromptItem) => void
}

/**
 * Phase 10-11C: shows a generated prompt-variation result for copy-only use.
 * Nothing here writes back to the image's prompt — no "apply to prompt"
 * button is offered by design (the generated text is never auto-saved or
 * auto-applied; the user copies it and edits the real prompt manually via the
 * existing PromptEditor if they want to keep it).
 */
export default function PromptVariationModal({
  text,
  onClose,
  sourceImageId,
  sourceImageName,
  changes,
  onFavoriteSave,
}: PromptVariationModalProps) {
  const [copyMsg, setCopyMsg] = useState<string | null>(null)
  const [favoriteMsg, setFavoriteMsg] = useState<string | null>(null)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopyMsg("コピーしました ✓")
      setTimeout(() => setCopyMsg(null), 2000)
    } catch {
      setCopyMsg("コピーに失敗しました")
      setTimeout(() => setCopyMsg(null), 2000)
    }
  }

  const canSaveFavorite = sourceImageId != null && sourceImageName != null && onFavoriteSave != null

  const handleFavoriteSave = () => {
    if (!canSaveFavorite) return
    const item = makeFavoritePromptItem({
      sourceImageId: sourceImageId!,
      sourceImageName: sourceImageName!,
      text,
      kind: "variation",
      changes,
    })
    onFavoriteSave!(item)
    setFavoriteMsg("お気に入りに保存しました ✓")
    setTimeout(() => setFavoriteMsg(null), 2000)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />

      {/* Panel */}
      <div className="relative flex max-h-[85dvh] w-full max-w-lg flex-col rounded-lg bg-white shadow-xl">
        <div className="flex flex-shrink-0 items-center justify-between border-b border-zinc-200 px-4 py-3">
          <span className="text-sm font-semibold text-zinc-800">生成されたプロンプト</span>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-700"
            aria-label="閉じる"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          <p className="whitespace-pre-wrap break-words rounded bg-zinc-50 p-3 text-sm text-zinc-700">
            {text}
          </p>
          <p className="mt-2 text-xs text-zinc-400">
            生成結果は保存されません。コピーして必要に応じて編集してください。
            お気に入り保存はこのブラウザにのみ保存され、DBには保存されません。
          </p>
          {favoriteMsg && <p className="mt-1 text-xs text-green-600">{favoriteMsg}</p>}
        </div>

        <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-t border-zinc-100 px-4 py-3">
          <button
            onClick={() => void handleCopy()}
            className="rounded-md bg-zinc-800 px-3 py-2 text-sm text-white hover:bg-zinc-600"
          >
            コピー
          </button>
          {canSaveFavorite && (
            <button
              onClick={handleFavoriteSave}
              className="rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
            >
              お気に入りに保存
            </button>
          )}
          {copyMsg && (
            <span className={`text-xs ${copyMsg.includes("失敗") ? "text-red-500" : "text-green-600"}`}>
              {copyMsg}
            </span>
          )}
          <button
            onClick={onClose}
            className="ml-auto rounded-md border border-zinc-200 px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-50"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}
