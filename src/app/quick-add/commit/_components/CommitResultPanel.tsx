"use client"

import { useMemo } from "react"

type CommitResultData = {
  summary: {
    requested: number
    committed: number
    skipped: number
    alreadyCommitted: number
    failed: number
    invalid: number
  }
  committed: Array<{ uploadItemId: string; imageId: string; status: string }>
  skipped: Array<{ uploadItemId: string; imageId: string; status: string }>
  alreadyCommitted: Array<{ uploadItemId: string; imageId: string; status: string }>
  failed: Array<{ uploadItemId: string; reason: string; message: string }>
  invalid: Array<{ uploadItemId: string; reason: string; message: string }>
  session: { id: string; status: string }
}

const INVALID_REASON_JA: Record<string, string> = {
  DUPLICATE_UNCHECKED: "重複チェックが未実行です。「重複チェック実行」ボタンを押してから再試行してください。",
  DUPLICATE_UNRESOLVED: "重複画像が未解決です。スキップするか解決してから保存してください。",
  UPLOAD_NOT_READY: "アップロードが完了していません（uploadStatus が READY でない）。",
  PROMPT_NOT_FILLED: "プロンプトが未入力です。",
  PROMPT_EMPTY: "プロンプトが空です。",
  INVALID_COMMIT_STATUS: "commitStatus が不正な状態です。",
  SKIPPED_WITHOUT_DUPLICATE_IMAGE_ID: "スキップ済みですが重複元 ID が不明です。",
  DUPLICATE_DETECTED_AT_COMMIT: "保存直前に重複が検出されました。重複チェックを再実行してください。",
}

function reasonJa(reason: string) {
  return INVALID_REASON_JA[reason] ?? reason
}

type Props = {
  result: CommitResultData
  sessionCommitted: boolean
  committing: boolean
  items: Record<string, unknown>[]
  onRetry: () => void
  onGoGallery: (url: string) => void
  onNewSession: () => void
}

export function CommitResultPanel({
  result,
  sessionCommitted,
  committing,
  items,
  onRetry,
  onGoGallery,
  onNewSession,
}: Props) {
  const { summary } = result
  const nothingCommitted = summary.committed === 0

  // Gallery URL: if exactly 1 image newly committed, search by its originalName
  const galleryUrl = useMemo(() => {
    if (result.committed.length === 1) {
      const uploadItemId = result.committed[0].uploadItemId
      const item = items.find((i) => i.id === uploadItemId)
      const name = item?.originalName as string | undefined
      if (name) {
        return `/gallery?q=${encodeURIComponent(name.replace(/\.[^.]+$/, ""))}`
      }
    }
    return "/gallery"
  }, [result.committed, items])

  return (
    <div
      className={`rounded-lg border p-4 flex flex-col gap-4 ${
        nothingCommitted && !sessionCommitted
          ? "border-amber-300 bg-amber-50"
          : "border-zinc-200 bg-white"
      }`}
    >
      {/* Title */}
      <div className="flex items-center gap-2">
        {sessionCommitted && summary.committed > 0 ? (
          <span className="text-base font-semibold text-green-700">✓ 保存完了</span>
        ) : nothingCommitted ? (
          <span className="text-base font-semibold text-amber-700">⚠ 新規保存 0 件</span>
        ) : (
          <span className="text-base font-semibold text-zinc-800">保存結果</span>
        )}
      </div>

      {/* Summary grid */}
      <div className="grid grid-cols-5 gap-2 text-center text-sm">
        <div className="flex flex-col gap-0.5">
          <span className={`text-xl font-bold ${summary.committed > 0 ? "text-green-700" : "text-zinc-400"}`}>
            {summary.committed}
          </span>
          <span className="text-xs text-zinc-500">新規保存</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className={`text-xl font-bold ${summary.skipped > 0 ? "text-zinc-600" : "text-zinc-300"}`}>
            {summary.skipped}
          </span>
          <span className="text-xs text-zinc-500">重複スキップ</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className={`text-xl font-bold ${summary.alreadyCommitted > 0 ? "text-zinc-600" : "text-zinc-300"}`}>
            {summary.alreadyCommitted}
          </span>
          <span className="text-xs text-zinc-500">既存保存済み</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className={`text-xl font-bold ${summary.failed > 0 ? "text-red-600" : "text-zinc-300"}`}>
            {summary.failed}
          </span>
          <span className="text-xs text-zinc-500">失敗</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className={`text-xl font-bold ${summary.invalid > 0 ? "text-amber-600" : "text-zinc-300"}`}>
            {summary.invalid}
          </span>
          <span className="text-xs text-zinc-500">無効</span>
        </div>
      </div>

      {/* invalid detail — most actionable */}
      {result.invalid.length > 0 && (
        <div className="rounded-md bg-amber-100 p-3 flex flex-col gap-1.5">
          <p className="text-xs font-semibold text-amber-800">無効アイテムの理由:</p>
          {Array.from(new Set(result.invalid.map((f) => f.reason))).map((reason) => (
            <p key={reason} className="text-xs text-amber-700">
              • {reasonJa(reason)}
            </p>
          ))}
        </div>
      )}

      {/* failed detail */}
      {result.failed.length > 0 && (
        <div className="rounded-md bg-red-50 p-3 flex flex-col gap-1">
          <p className="text-xs font-semibold text-red-700">失敗の詳細:</p>
          {result.failed.map((f) => (
            <p key={f.uploadItemId} className="text-xs text-red-600">
              • {f.reason}: {f.message}
            </p>
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap gap-3 mt-1">
        {sessionCommitted ? (
          <>
            <button
              onClick={() => onGoGallery(galleryUrl)}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1"
            >
              Gallery で確認 →
            </button>
            <button
              onClick={onNewSession}
              className="rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1"
            >
              新しいセッションを開始
            </button>
          </>
        ) : (
          <>
            <button
              onClick={onRetry}
              disabled={committing}
              className="rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1"
            >
              再試行
            </button>
            <button
              onClick={onNewSession}
              className="rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1"
            >
              Quick Add へ戻る
            </button>
          </>
        )}
      </div>
    </div>
  )
}
