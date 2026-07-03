"use client"

import { useEffect, useReducer, useState } from "react"
import { deleteImage, fetchImageDetail, type ImageDetail, type PromptVersionSummary } from "@/lib/gallery/imagesClient"

interface DetailPanelProps {
  imageId: string | null
  onClose: () => void
  onDeleted?: (imageId: string) => void
  hideHeader?: boolean
  /** 外部からfetch済みdetailを渡す場合（二重fetch防止） */
  prefetchedDetail?: ImageDetail | null
  prefetchedLoading?: boolean
  prefetchedError?: string | null
}

type DeletePhase = "view" | "confirm" | "deleting" | "error"

type State =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ok"; detail: ImageDetail; copyMsg: string | null }
  | { phase: "error"; message: string }

type Action =
  | { type: "load" }
  | { type: "ok"; detail: ImageDetail }
  | { type: "error"; message: string }
  | { type: "copy_msg"; msg: string | null }
  | { type: "update_prompt"; prompt: ImageDetail["prompt"] }

function reducer(s: State, a: Action): State {
  if (a.type === "load") return { phase: "loading" }
  if (a.type === "ok") return { phase: "ok", detail: a.detail, copyMsg: null }
  if (a.type === "error") return { phase: "error", message: a.message }
  if (a.type === "copy_msg" && s.phase === "ok") return { ...s, copyMsg: a.msg }
  if (a.type === "update_prompt" && s.phase === "ok") {
    return { ...s, detail: { ...s.detail, prompt: a.prompt } }
  }
  return s
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function PreviewImage({ detail }: { detail: ImageDetail }) {
  const src =
    detail.signedUrls.previewUrl ??
    detail.signedUrls.thumbnailUrl ??
    detail.signedUrls.originalUrl

  const [failed, dispatchFailed] = useReducer(() => true, false)

  if (!src || failed) {
    return (
      <div className="flex h-40 items-center justify-center rounded-lg bg-zinc-100 text-xs text-zinc-400">
        プレビューなし
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-lg bg-zinc-100">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={detail.originalName}
        className="h-auto max-h-64 w-full object-contain"
        onError={() => dispatchFailed()}
      />
    </div>
  )
}

// ---- PromptEditor ----

type EditPhase = "view" | "editing" | "saving" | "saved" | "error"

function PromptEditor({
  imageId,
  prompt,
  onSaved,
}: {
  imageId: string
  prompt: NonNullable<ImageDetail["prompt"]>
  onSaved: (updated: ImageDetail["prompt"]) => void
}) {
  const [phase, setPhase] = useState<EditPhase>("view")
  const [draft, setDraft] = useState(prompt.currentBody)
  const [changeNote, setChangeNote] = useState("")
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const startEdit = () => {
    setDraft(prompt.currentBody)
    setChangeNote("")
    setErrorMsg(null)
    setPhase("editing")
  }

  const cancel = () => {
    setPhase("view")
    setErrorMsg(null)
  }

  const save = async () => {
    const trimmed = draft.trim()
    if (!trimmed) {
      setErrorMsg("プロンプトを入力してください")
      return
    }
    setPhase("saving")
    setErrorMsg(null)
    try {
      const res = await fetch(`/api/images/${imageId}/prompt`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentBody: trimmed, changeNote }),
      })
      if (!res.ok) {
        const j = (await res.json()) as { error?: { message?: string } }
        throw new Error(j.error?.message ?? `HTTP ${res.status}`)
      }
      const j = (await res.json()) as { data: { prompt: ImageDetail["prompt"] } }
      setPhase("saved")
      onSaved(j.data.prompt)
      setTimeout(() => setPhase("view"), 2000)
    } catch (e: unknown) {
      setErrorMsg((e as Error).message ?? "保存に失敗しました")
      setPhase("error")
    }
  }

  if (phase === "view" || phase === "saved") {
    return (
      <div>
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">プロンプト</p>
          <div className="flex items-center gap-2">
            {phase === "saved" && (
              <span className="text-xs text-green-600">保存しました ✓</span>
            )}
            <CopyButton text={prompt.currentBody} label="コピー" />
            <button
              onClick={startEdit}
              className="text-xs text-zinc-400 hover:text-zinc-700"
            >
              編集
            </button>
          </div>
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words rounded bg-zinc-50 p-2 text-xs text-zinc-700">
          {prompt.currentBody}
        </p>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">プロンプト編集</p>
      </div>
      <textarea
        className="mt-1 w-full rounded border border-zinc-300 p-2 text-xs text-zinc-800 focus:border-blue-400 focus:outline-none"
        rows={8}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        disabled={phase === "saving"}
      />
      <input
        type="text"
        placeholder="変更メモ（任意）"
        value={changeNote}
        onChange={(e) => setChangeNote(e.target.value)}
        disabled={phase === "saving"}
        className="mt-1 w-full rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-700 focus:border-blue-400 focus:outline-none"
      />
      {errorMsg && (
        <p className="mt-1 text-xs text-red-500">{errorMsg}</p>
      )}
      <div className="mt-2 flex gap-2">
        <button
          onClick={() => void save()}
          disabled={phase === "saving"}
          className="rounded bg-zinc-800 px-3 py-1 text-xs text-white hover:bg-zinc-600 disabled:opacity-50"
        >
          {phase === "saving" ? "保存中..." : "保存"}
        </button>
        <button
          onClick={cancel}
          disabled={phase === "saving"}
          className="text-xs text-zinc-400 hover:text-zinc-700"
        >
          キャンセル
        </button>
      </div>
    </div>
  )
}

// ---- CopyButton: 独立した copy feedback を持つ ----

function CopyButton({ text, label = "コピー" }: { text: string; label?: string }) {
  const [msg, setMsg] = useState<string | null>(null)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setMsg("コピーしました ✓")
      setTimeout(() => setMsg(null), 2000)
    } catch {
      setMsg("コピーに失敗しました")
      setTimeout(() => setMsg(null), 2000)
    }
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        onClick={() => void handleCopy()}
        className="text-xs text-zinc-400 hover:text-zinc-700"
      >
        {label}
      </button>
      {msg && (
        <span className={`text-xs ${msg.includes("失敗") ? "text-red-500" : "text-green-600"}`}>
          {msg}
        </span>
      )}
    </span>
  )
}

// ---- PromptVersionCard ----

const VERSION_PREVIEW_LEN = 300

function PromptVersionCard({ version }: { version: PromptVersionSummary }) {
  const [expanded, setExpanded] = useState(false)
  const isLong = version.body.length > VERSION_PREVIEW_LEN
  const displayBody = expanded ? version.body : version.body.slice(0, VERSION_PREVIEW_LEN)

  return (
    <div className="rounded-md border border-zinc-100 bg-zinc-50 p-2.5 text-xs">
      {/* Header row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
            version.versionType === "EDIT"
              ? "bg-indigo-100 text-indigo-700"
              : "bg-purple-100 text-purple-700"
          }`}>
            {version.versionType === "EDIT" ? "Edit" : "Scene"}
          </span>
          <span className="text-zinc-400">
            {new Date(version.createdAt).toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>
        <CopyButton text={version.body} label="コピー" />
      </div>

      {/* Scene */}
      {version.scene && (
        <p className="mt-1 text-zinc-500">シーン: {version.scene.name}</p>
      )}

      {/* changeNote */}
      {version.changeNote && (
        <p className="mt-1 text-zinc-500 break-all">{version.changeNote}</p>
      )}

      {/* Body preview */}
      <p className="mt-1.5 whitespace-pre-wrap break-words text-zinc-700">
        {displayBody}
        {!expanded && isLong && <span className="text-zinc-400">…</span>}
      </p>

      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-zinc-400 hover:text-zinc-600"
        >
          {expanded ? "閉じる ▲" : "全文表示 ▼"}
        </button>
      )}
    </div>
  )
}

// ---- PromptVersionsSection ----

function PromptVersionsSection({ versions }: { versions: PromptVersionSummary[] }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
        プロンプト履歴
      </p>
      {versions.length === 0 ? (
        <p className="mt-1 text-xs text-zinc-400">履歴はありません</p>
      ) : (
        <div className="mt-1.5 flex flex-col gap-2">
          {versions.map((v) => (
            <PromptVersionCard key={v.id} version={v} />
          ))}
        </div>
      )}
    </div>
  )
}

// ---- Main ----

export default function DetailPanel({
  imageId,
  onClose,
  onDeleted,
  hideHeader = false,
  prefetchedDetail,
  prefetchedLoading,
  prefetchedError,
}: DetailPanelProps) {
  const usePrefetch = prefetchedDetail !== undefined || prefetchedLoading !== undefined || prefetchedError !== undefined
  const [state, dispatch] = useReducer(reducer, { phase: "idle" })
  const [deletePhase, setDeletePhase] = useState<DeletePhase>("view")
  const [deleteError, setDeleteError] = useState<string | null>(null)
  // 画像切り替え時に削除UIをリセット（render中に前回値と比較する React 推奨パターン）
  const [prevImageId, setPrevImageId] = useState(imageId)
  if (imageId !== prevImageId) {
    setPrevImageId(imageId)
    setDeletePhase("view")
    setDeleteError(null)
  }

  // 外部からdetailが渡された場合はstateに同期する（内部fetchは不要）
  useEffect(() => {
    if (!usePrefetch) return
    if (prefetchedLoading) {
      dispatch({ type: "load" })
    } else if (prefetchedError) {
      dispatch({ type: "error", message: prefetchedError })
    } else if (prefetchedDetail) {
      dispatch({ type: "ok", detail: prefetchedDetail })
    } else if (!imageId) {
      // idle
    }
  }, [usePrefetch, prefetchedLoading, prefetchedError, prefetchedDetail, imageId])

  // 内部fetch: prefetchを使わない場合のみ
  useEffect(() => {
    if (usePrefetch) return
    if (!imageId) return
    const controller = new AbortController()
    dispatch({ type: "load" })
    fetchImageDetail(imageId)
      .then((detail) => {
        if (!controller.signal.aborted) dispatch({ type: "ok", detail })
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted)
          dispatch({ type: "error", message: (e as Error).message ?? "エラーが発生しました" })
      })
    return () => controller.abort()
  }, [imageId, usePrefetch])

  // prompt/notes コピーは panel-level の copyMsg に統合
  const handleCopyLegacy = async (body: string) => {
    try {
      await navigator.clipboard.writeText(body)
      dispatch({ type: "copy_msg", msg: "コピーしました ✓" })
      setTimeout(() => dispatch({ type: "copy_msg", msg: null }), 2000)
    } catch {
      dispatch({ type: "copy_msg", msg: "コピーに失敗しました" })
      setTimeout(() => dispatch({ type: "copy_msg", msg: null }), 2000)
    }
  }

  const handleDelete = async (id: string) => {
    setDeletePhase("deleting")
    setDeleteError(null)
    try {
      await deleteImage(id)
      // 成功: 親に通知（一覧から除去 + パネルclose は delete_ok reducer が担当）
      onDeleted?.(id)
    } catch (e: unknown) {
      setDeleteError((e as Error).message ?? "削除に失敗しました")
      setDeletePhase("error")
    }
  }

  if (!imageId) return null

  return (
    <aside className="flex w-80 flex-shrink-0 flex-col overflow-y-auto border-l border-zinc-200 bg-white">
      {/* Header */}
      {!hideHeader && (
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
          <span className="text-sm font-semibold text-zinc-800">詳細</span>
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
      )}

      {state.phase === "loading" && (
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-400">
          読み込み中...
        </div>
      )}

      {state.phase === "error" && (
        <div className="p-4 text-sm text-red-500">{state.message}</div>
      )}

      {state.phase === "ok" && (
        <div className="flex flex-col gap-4 p-4">
          <PreviewImage detail={state.detail} />

          {/* File info */}
          <div>
            <p className="break-all text-sm font-medium text-zinc-900">{state.detail.originalName}</p>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-zinc-500">
              <span>{state.detail.originalExt.toUpperCase()}</span>
              <span>{formatBytes(state.detail.fileSizeBytes)}</span>
              {state.detail.widthPx && state.detail.heightPx && (
                <span>{state.detail.widthPx}×{state.detail.heightPx}</span>
              )}
              {state.detail.isFavorite && <span className="text-yellow-500">★ お気に入り</span>}
            </div>
          </div>

          {state.detail.scene && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">シーン</p>
              <p className="mt-0.5 text-sm text-zinc-700">{state.detail.scene.name}</p>
            </div>
          )}

          {state.detail.tags.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">タグ</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {state.detail.tags.map((t) => (
                  <span key={t.id} className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700">
                    {t.name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {state.detail.persons.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">人物</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {state.detail.persons.map((p) => (
                  <span key={p.id} className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700">
                    {p.name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {state.detail.prompt && (
            <PromptEditor
              imageId={state.detail.id}
              prompt={state.detail.prompt}
              onSaved={(updatedPrompt) => dispatch({ type: "update_prompt", prompt: updatedPrompt })}
            />
          )}

          {state.detail.notes && (
            <div>
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">メモ</p>
                <button
                  onClick={() => void handleCopyLegacy(state.detail.notes!)}
                  className="text-xs text-zinc-400 hover:text-zinc-700"
                >
                  コピー
                </button>
              </div>
              <p className="mt-0.5 whitespace-pre-wrap text-xs text-zinc-700">{state.detail.notes}</p>
            </div>
          )}

          {/* Prompt versions */}
          {state.detail.prompt && (
            <PromptVersionsSection versions={state.detail.prompt.versions} />
          )}

          {(state.detail.sourceSheetName || state.detail.importBatchId || state.detail.fileHashSnippet) && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">インポート情報</p>
              <div className="mt-1 space-y-0.5 text-xs text-zinc-500">
                {state.detail.sourceSheetName && (
                  <p>シート: {state.detail.sourceSheetName}{state.detail.sourceRow != null ? ` 行${state.detail.sourceRow}` : ""}{state.detail.sourceColumn != null ? ` 列${state.detail.sourceColumn}` : ""}</p>
                )}
                {state.detail.fileHashSnippet && (
                  <p className="font-mono">Hash: {state.detail.fileHashSnippet}…</p>
                )}
                {state.detail.importBatchId && (
                  <p className="truncate font-mono">Batch: {state.detail.importBatchId.slice(0, 12)}…</p>
                )}
              </div>
            </div>
          )}

          <div className="text-xs text-zinc-400">
            <p>登録: {new Date(state.detail.createdAt).toLocaleString("ja-JP")}</p>
          </div>

          {state.detail.signedUrls.originalUrl && (
            <a
              href={state.detail.signedUrls.originalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md border border-zinc-200 px-3 py-2 text-center text-xs text-zinc-600 hover:bg-zinc-50"
            >
              オリジナルを開く ↗
            </a>
          )}

          {/* 削除 (soft delete) */}
          <div className="mt-2 border-t border-zinc-100 pt-3">
            {deletePhase === "view" && (
              <button
                onClick={() => setDeletePhase("confirm")}
                className="w-full rounded-md border border-red-200 px-3 py-2 text-center text-xs text-red-600 hover:bg-red-50"
              >
                画像を削除
              </button>
            )}

            {deletePhase === "confirm" && (
              <div className="flex flex-col gap-2">
                <p className="text-xs text-red-600">この画像を削除しますか？</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleDelete(state.detail.id)}
                    className="flex-1 rounded-md bg-red-600 px-3 py-2 text-center text-xs font-medium text-white hover:bg-red-700"
                  >
                    削除する
                  </button>
                  <button
                    onClick={() => setDeletePhase("view")}
                    className="flex-1 rounded-md border border-zinc-200 px-3 py-2 text-center text-xs text-zinc-600 hover:bg-zinc-50"
                  >
                    キャンセル
                  </button>
                </div>
              </div>
            )}

            {deletePhase === "deleting" && (
              <button
                disabled
                className="w-full cursor-not-allowed rounded-md border border-zinc-200 px-3 py-2 text-center text-xs text-zinc-400"
              >
                削除中...
              </button>
            )}

            {deletePhase === "error" && (
              <div className="flex flex-col gap-2">
                <p className="text-xs text-red-600">{deleteError ?? "削除に失敗しました"}</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleDelete(state.detail.id)}
                    className="flex-1 rounded-md bg-red-600 px-3 py-2 text-center text-xs font-medium text-white hover:bg-red-700"
                  >
                    再試行
                  </button>
                  <button
                    onClick={() => setDeletePhase("view")}
                    className="flex-1 rounded-md border border-zinc-200 px-3 py-2 text-center text-xs text-zinc-600 hover:bg-zinc-50"
                  >
                    キャンセル
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  )
}
