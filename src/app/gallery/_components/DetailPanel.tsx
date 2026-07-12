"use client"

import { useEffect, useReducer, useState } from "react"
import {
  analyzeImage,
  approveSuggestion,
  deleteImage,
  fetchImageDetail,
  generatePromptVariation,
  rejectSuggestion,
  removeImageTag,
  translatePrompt,
  type ImageDetail,
  type PromptVersionSummary,
  type TagSuggestion,
  type TranslatePromptResult,
  type VariationChange,
} from "@/lib/gallery/imagesClient"
import { applyPromptEditToDetailPrompt } from "@/lib/gallery/translationState"
import { describeTranslationResult, type TranslationDisplayMessage } from "@/lib/translation/translationResultDisplay"
import { VARIATION_CHANGE_OPTIONS, toggleVariationChange } from "@/lib/gallery/variationChangeOptions"
import {
  readPromptVariationHistory,
  addPromptVariationHistoryItem,
  removePromptVariationHistoryItem,
  clearPromptVariationHistory,
  formatVariationChanges,
  makePromptVariationHistoryItem,
  type PromptVariationHistoryItem,
} from "@/lib/gallery/promptVariationHistory"
import PromptVariationModal from "./PromptVariationModal"

/** Phase 10-12A: safe localStorage accessor — browser-only, never throws (some
 *  sandboxed/private-mode contexts throw on the `window.localStorage` getter
 *  itself, before any get/set call). Returns undefined when unavailable so the
 *  pure history helpers' storage?-optional path (no-op) kicks in. */
function getLocalStorage(): Storage | undefined {
  try {
    return typeof window !== "undefined" ? window.localStorage : undefined
  } catch {
    return undefined
  }
}

/** Emitted after an AI tag candidate is approved or rejected (server call already succeeded). */
export type SuggestionResolvedPayload = {
  suggestionId: string
  action: "approved" | "rejected"
  tag?: { id: string; name: string } | null
}

interface DetailPanelProps {
  imageId: string | null
  onClose: () => void
  onDeleted?: (imageId: string) => void
  onSuggestionResolved?: (payload: SuggestionResolvedPayload) => void
  onAnalyzed?: (suggestions: TagSuggestion[]) => void
  onTagRemoved?: (tagId: string) => void
  /** Phase 10-9C-4: single-image translation applied (fold into shared detail). */
  onTranslated?: (result: TranslatePromptResult) => void
  /** Phase 10-9C-4: prompt edited — propagate to shared state so a stale
   *  translation is cleared and a later translate uses the fresh body. */
  onPromptSaved?: (prompt: ImageDetail["prompt"]) => void
  hideHeader?: boolean
  /** Phase 10-8C: モバイルdrawer用。デスクトップ幅 w-80 固定を解除する */
  fullWidth?: boolean
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
    // Reset a stale translation on body change (mirrors resetTranslationCacheData).
    const prompt =
      s.detail.prompt && a.prompt
        ? applyPromptEditToDetailPrompt(s.detail.prompt, a.prompt)
        : a.prompt
    return { ...s, detail: { ...s.detail, prompt } }
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

const PROMPT_PREVIEW_LEN = 350

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
  const [expanded, setExpanded] = useState(false)
  // 画像切り替え時に展開状態をリセット（他subcomponentと同じprevId比較パターン）
  const [prevImageId, setPrevImageId] = useState(imageId)
  if (imageId !== prevImageId) {
    setPrevImageId(imageId)
    setExpanded(false)
  }

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
    const isLong = prompt.currentBody.length > PROMPT_PREVIEW_LEN
    const displayBody = expanded ? prompt.currentBody : prompt.currentBody.slice(0, PROMPT_PREVIEW_LEN)
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
          {displayBody}
          {!expanded && isLong && <span className="text-zinc-400">…</span>}
        </p>
        {isLong && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="mt-1 text-xs text-zinc-400 hover:text-zinc-600"
          >
            {expanded ? "閉じる ▲" : "全文表示 ▼"}
          </button>
        )}
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

// ---- TranslationSection: プロンプトの日本語訳 表示/追加/再生成 (Phase 10-9C-4) ----
//
// 表示は server 計算の prompt.effectiveTranslatedBodyJa のみ (raw translatedBodyJa
// や client hash は使わない → stale訳は出ない)。翻訳ボタンは translationEnabled=true
// かつ prompt あり の時だけ表示 → mock/disabled 時に翻訳APIを呼ぶ導線を作らない。

type TranslatePhase = "idle" | "translating"

function TranslationSection({
  imageId,
  prompt,
  translationEnabled,
  onTranslated,
}: {
  imageId: string
  prompt: NonNullable<ImageDetail["prompt"]>
  translationEnabled: boolean
  onTranslated?: (result: TranslatePromptResult) => void
}) {
  const [phase, setPhase] = useState<TranslatePhase>("idle")
  const [message, setMessage] = useState<TranslationDisplayMessage | null>(null)
  const [expanded, setExpanded] = useState(false)
  // 画像切り替え時にリセット (他subcomponentと同じ prevId 比較パターン)
  const [prevImageId, setPrevImageId] = useState(imageId)
  if (imageId !== prevImageId) {
    setPrevImageId(imageId)
    setPhase("idle")
    setMessage(null)
    setExpanded(false)
  }

  const effective = prompt.effectiveTranslatedBodyJa
  const hasTranslation = effective != null && effective.trim() !== ""

  // 翻訳もなく、機能も無効 (mock/disabled) なら何も描画しない。
  if (!hasTranslation && !translationEnabled) return null

  const run = async () => {
    setPhase("translating")
    setMessage(null)
    try {
      // 既存訳ありなら再生成 (force)。連打は phase=translating で disabled。
      const result = await translatePrompt(imageId, hasTranslation ? { force: true } : undefined)
      setMessage(describeTranslationResult(result))
      onTranslated?.(result)
    } catch (e: unknown) {
      setMessage({ text: (e as Error).message ?? "翻訳に失敗しました", tone: "error" })
    } finally {
      setPhase("idle")
    }
  }

  const isLong = hasTranslation && effective.length > PROMPT_PREVIEW_LEN
  const displayBody = hasTranslation
    ? expanded
      ? effective
      : effective.slice(0, PROMPT_PREVIEW_LEN)
    : null

  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">日本語訳</p>
        {hasTranslation && <CopyButton text={effective} label="コピー" />}
      </div>

      {hasTranslation ? (
        <>
          <p className="mt-1 whitespace-pre-wrap break-words rounded bg-blue-50 p-2 text-xs text-zinc-700">
            {displayBody}
            {!expanded && isLong && <span className="text-zinc-400">…</span>}
          </p>
          {isLong && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="mt-1 text-xs text-zinc-400 hover:text-zinc-600"
            >
              {expanded ? "閉じる ▲" : "全文表示 ▼"}
            </button>
          )}
        </>
      ) : (
        <p className="mt-1 text-xs text-zinc-400">日本語訳はまだありません</p>
      )}

      {translationEnabled && (
        <button
          onClick={() => void run()}
          disabled={phase === "translating"}
          className="mt-2 rounded-md border border-zinc-300 px-3 py-2 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
        >
          {phase === "translating" ? "翻訳中..." : hasTranslation ? "日本語訳を再生成" : "日本語訳を追加"}
        </button>
      )}

      {message && (
        <p
          className={`mt-1 text-xs ${
            message.tone === "error"
              ? "text-red-500"
              : message.tone === "info"
                ? "text-zinc-500"
                : "text-green-600"
          }`}
        >
          {message.text}
        </p>
      )}
    </div>
  )
}

// ---- PromptVariationSection: 既存promptから新しいprompt案を生成 (Phase 10-11C) ----
//
// 生成結果はDB保存しない・Prompt.currentBodyを自動更新しない・PromptVersionを
// 作らない。modal表示 + コピーのみ。variationEnabled=true かつ prompt あり の
// 時だけ表示（disabled/mock時にAPIを呼ぶ導線を作らない、TranslationSectionと同方針）。
//
// Phase 10-12A: 生成成功時のみ、ブラウザの localStorage に画像ごと直近5件だけ
// 「最近生成した案」として一時保存する（DB非接触・サーバーには一切送られない）。

type VariationPhase = "idle" | "generating"
type VariationMessage = { text: string; tone: "info" | "error" }

function describeVariationFailure(status: "disabled" | "no_prompt" | "FAILED", error?: string): VariationMessage {
  if (status === "disabled") return { text: "この機能は現在利用できません", tone: "info" }
  if (status === "no_prompt") return { text: "プロンプトがないため生成できません", tone: "info" }
  return { text: `生成に失敗しました: ${error ?? "不明なエラー"}`, tone: "error" }
}

const HISTORY_PREVIEW_LEN = 140

function formatHistoryCreatedAt(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
}

function PromptVariationSection({
  imageId,
  variationEnabled,
}: {
  imageId: string
  variationEnabled: boolean
}) {
  const [selected, setSelected] = useState<VariationChange[]>([])
  const [phase, setPhase] = useState<VariationPhase>("idle")
  const [message, setMessage] = useState<VariationMessage | null>(null)
  const [resultText, setResultText] = useState<string | null>(null)
  // lazy init: reads localStorage once on mount (not on every render).
  const [history, setHistory] = useState<PromptVariationHistoryItem[]>(() =>
    readPromptVariationHistory(imageId, getLocalStorage()),
  )
  // 画像切り替え時にリセット（他subcomponentと同じ prevId 比較パターン）。
  // history もここで該当imageIdの内容に読み直す（useEffectではなくrender中の
  // setState — 既存パターンと同型で、effect内setStateのlintを避ける）。
  const [prevImageId, setPrevImageId] = useState(imageId)
  if (imageId !== prevImageId) {
    setPrevImageId(imageId)
    setSelected([])
    setPhase("idle")
    setMessage(null)
    setResultText(null)
    setHistory(readPromptVariationHistory(imageId, getLocalStorage()))
  }

  if (!variationEnabled) return null

  const run = async () => {
    setPhase("generating")
    setMessage(null)
    try {
      const result = await generatePromptVariation(imageId, selected)
      if (result.status === "DONE" && result.variation) {
        setResultText(result.variation.text)
        const item = makePromptVariationHistoryItem(imageId, result.variation.text, selected)
        setHistory(addPromptVariationHistoryItem(imageId, item, getLocalStorage()))
      } else {
        setMessage(describeVariationFailure(result.status as "disabled" | "no_prompt" | "FAILED", result.error))
      }
    } catch (e: unknown) {
      setMessage({ text: (e as Error).message ?? "生成に失敗しました", tone: "error" })
    } finally {
      setPhase("idle")
    }
  }

  const handleRemoveHistoryItem = (itemId: string) => {
    setHistory(removePromptVariationHistoryItem(imageId, itemId, getLocalStorage()))
  }

  const handleClearHistory = () => {
    clearPromptVariationHistory(imageId, getLocalStorage())
    setHistory([])
  }

  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">プロンプトバリエーション</p>
      <div className="mt-1.5 flex flex-col gap-1">
        {VARIATION_CHANGE_OPTIONS.map((opt) => (
          <label key={opt.value} className="flex items-center gap-2 text-xs text-zinc-700">
            <input
              type="checkbox"
              checked={selected.includes(opt.value)}
              onChange={() => setSelected((prev) => toggleVariationChange(prev, opt.value))}
              disabled={phase === "generating"}
            />
            {opt.label}
          </label>
        ))}
      </div>
      <button
        onClick={() => void run()}
        disabled={selected.length === 0 || phase === "generating"}
        className="mt-2 rounded-md border border-zinc-300 px-3 py-2 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
      >
        {phase === "generating" ? "生成中..." : "新しいプロンプトを生成"}
      </button>
      <p className="mt-1 text-xs text-zinc-400">
        生成結果はこのブラウザに一時保存されます。既存promptには反映されません。必要に応じてコピーして編集してください。
      </p>
      {message && (
        <p className={`mt-1 text-xs ${message.tone === "error" ? "text-red-500" : "text-zinc-500"}`}>
          {message.text}
        </p>
      )}
      {resultText !== null && (
        <PromptVariationModal text={resultText} onClose={() => setResultText(null)} />
      )}

      {history.length > 0 && (
        <div className="mt-3 border-t border-zinc-100 pt-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">最近生成した案</p>
            <button
              onClick={handleClearHistory}
              className="text-xs text-zinc-400 hover:text-red-600"
            >
              すべて削除
            </button>
          </div>
          <div className="mt-1.5 flex flex-col gap-2">
            {history.map((item) => {
              const isLong = item.text.length > HISTORY_PREVIEW_LEN
              const preview = isLong ? `${item.text.slice(0, HISTORY_PREVIEW_LEN)}…` : item.text
              return (
                <div key={item.id} className="rounded-md border border-zinc-100 bg-zinc-50 p-2 text-xs">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-zinc-400">
                    <span>{formatHistoryCreatedAt(item.createdAt)}</span>
                    {item.changes.length > 0 && <span>{formatVariationChanges(item.changes)}</span>}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-zinc-700">{preview}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => setResultText(item.text)}
                      className="text-zinc-500 hover:text-zinc-800"
                    >
                      表示
                    </button>
                    <CopyButton text={item.text} label="コピー" />
                    <button
                      onClick={() => handleRemoveHistoryItem(item.id)}
                      className="text-zinc-400 hover:text-red-600"
                    >
                      削除
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
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

// ---- SuggestionCard: AIタグ候補1件の承認/却下/編集して承認（カード型・押しやすいボタン） ----

type SuggestionPhase = "view" | "editing" | "submitting" | "error"

function SuggestionCard({
  imageId,
  suggestion,
  onResolved,
}: {
  imageId: string
  suggestion: TagSuggestion
  onResolved: (payload: SuggestionResolvedPayload) => void
}) {
  const [phase, setPhase] = useState<SuggestionPhase>("view")
  const [draft, setDraft] = useState(suggestion.label)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const startEdit = () => {
    setDraft(suggestion.label)
    setErrorMsg(null)
    setPhase("editing")
  }

  const approve = async (label?: string) => {
    setPhase("submitting")
    setErrorMsg(null)
    try {
      const res = await approveSuggestion(imageId, suggestion.id, label)
      onResolved({ suggestionId: suggestion.id, action: "approved", tag: res.tag })
    } catch (e: unknown) {
      setErrorMsg((e as Error).message ?? "承認に失敗しました")
      setPhase("error")
    }
  }

  const reject = async () => {
    setPhase("submitting")
    setErrorMsg(null)
    try {
      await rejectSuggestion(imageId, suggestion.id)
      onResolved({ suggestionId: suggestion.id, action: "rejected" })
    } catch (e: unknown) {
      setErrorMsg((e as Error).message ?? "却下に失敗しました")
      setPhase("error")
    }
  }

  if (phase === "editing") {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-2.5">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={40}
          className="w-full rounded border border-amber-300 bg-white px-2 py-2 text-sm text-zinc-800 focus:outline-none"
        />
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => void approve(draft)}
            className="flex-1 rounded-md bg-amber-600 px-3 py-2.5 text-center text-sm font-medium text-white hover:bg-amber-700"
          >
            保存して承認
          </button>
          <button
            onClick={() => setPhase("view")}
            className="flex-1 rounded-md border border-zinc-200 px-3 py-2.5 text-center text-sm text-zinc-600 hover:bg-zinc-50"
          >
            キャンセル
          </button>
        </div>
      </div>
    )
  }

  if (phase === "submitting") {
    return (
      <div className="rounded-md border border-amber-100 bg-amber-50 p-2.5 text-sm text-amber-400">
        {suggestion.label} …
      </div>
    )
  }

  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 p-2.5">
      <p className="text-sm text-amber-800">{suggestion.label}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          onClick={() => void approve()}
          className="min-w-[64px] flex-1 rounded-md bg-amber-600 px-3 py-2.5 text-center text-sm font-medium text-white hover:bg-amber-700"
        >
          承認
        </button>
        <button
          onClick={startEdit}
          className="min-w-[64px] flex-1 rounded-md border border-amber-300 bg-white px-3 py-2.5 text-center text-sm text-amber-700 hover:bg-amber-50"
        >
          編集
        </button>
        <button
          onClick={() => void reject()}
          className="min-w-[64px] flex-1 rounded-md border border-zinc-200 bg-white px-3 py-2.5 text-center text-sm text-zinc-600 hover:bg-red-50 hover:text-red-600"
        >
          却下
        </button>
      </div>
      {phase === "error" && errorMsg && <p className="mt-1.5 text-xs text-red-500">{errorMsg}</p>}
    </div>
  )
}

// ---- TagChip: 承認済み/通常タグを画像から外す（2段階confirm, Phase 10-6B） ----

type TagChipPhase = "view" | "confirm" | "removing" | "error"

function TagChip({
  imageId,
  tag,
  onRemoved,
}: {
  imageId: string
  tag: { id: string; name: string }
  onRemoved: (tagId: string) => void
}) {
  const [phase, setPhase] = useState<TagChipPhase>("view")
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const remove = async () => {
    setPhase("removing")
    setErrorMsg(null)
    try {
      await removeImageTag(imageId, tag.id)
      // 親stateから消える（GalleryClient reducer 経由）。ローカルphaseは戻さない。
      onRemoved(tag.id)
    } catch (e: unknown) {
      setErrorMsg((e as Error).message ?? "タグを外せませんでした")
      setPhase("error")
    }
  }

  if (phase === "confirm") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 py-1 pl-2.5 pr-1 text-xs text-zinc-700">
        <span>{tag.name}</span>
        <button
          onClick={() => void remove()}
          className="rounded px-1.5 py-1 text-red-600 hover:bg-red-50 hover:text-red-800"
          aria-label="外す"
        >
          外す
        </button>
        <button
          onClick={() => setPhase("view")}
          className="rounded px-1.5 py-1 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700"
          aria-label="キャンセル"
        >
          キャンセル
        </button>
      </span>
    )
  }

  if (phase === "removing") {
    return (
      <span className="inline-flex items-center rounded-full bg-zinc-100 px-2.5 py-1 text-xs text-zinc-400">
        {tag.name} …
      </span>
    )
  }

  return (
    <span className="inline-flex flex-col">
      <span className="inline-flex items-center gap-0.5 rounded-full bg-zinc-100 py-1 pl-2.5 pr-1 text-xs text-zinc-700">
        <span>{tag.name}</span>
        <button
          onClick={() => setPhase("confirm")}
          className="rounded px-1.5 py-1 text-zinc-400 hover:bg-zinc-200 hover:text-red-600"
          aria-label={`タグ「${tag.name}」を外す`}
        >
          ×
        </button>
      </span>
      {phase === "error" && errorMsg && <span className="mt-0.5 text-xs text-red-500">{errorMsg}</span>}
    </span>
  )
}

// ---- AnalyzeSection: AI解析トリガー（mock provider, Phase 10-4） ----

type AnalyzePhase = "idle" | "analyzing"
type AnalyzeMessage = { text: string; tone: "ok" | "info" | "error" }

function describeAnalysisResult(analysis: {
  status: "DONE" | "FAILED" | "SKIPPED_NO_PROMPT"
  error: string | null
  suggestions: TagSuggestion[]
}, cached: boolean): AnalyzeMessage {
  const suffix = cached ? "（キャッシュ済み）" : ""
  if (analysis.status === "SKIPPED_NO_PROMPT") {
    return { text: `プロンプトがないため解析をスキップしました${suffix}`, tone: "info" }
  }
  if (analysis.status === "FAILED") {
    return { text: `解析に失敗しました${suffix}: ${analysis.error ?? "不明なエラー"}`, tone: "error" }
  }
  const n = analysis.suggestions.length
  return n > 0
    ? { text: `AIタグ候補を${n}件見つけました${suffix}`, tone: "ok" }
    : { text: `解析は完了しましたが候補はありませんでした${suffix}`, tone: "ok" }
}

function AnalyzeSection({
  imageId,
  onAnalyzed,
}: {
  imageId: string
  onAnalyzed?: (suggestions: TagSuggestion[]) => void
}) {
  const [phase, setPhase] = useState<AnalyzePhase>("idle")
  const [message, setMessage] = useState<AnalyzeMessage | null>(null)
  const [hasResult, setHasResult] = useState(false)
  // 画像切り替え時にリセット
  const [prevImageId, setPrevImageId] = useState(imageId)
  if (imageId !== prevImageId) {
    setPrevImageId(imageId)
    setPhase("idle")
    setMessage(null)
    setHasResult(false)
  }

  const run = async (force: boolean) => {
    setPhase("analyzing")
    setMessage(null)
    try {
      const result = await analyzeImage(imageId, { force })
      setHasResult(true)
      setMessage(describeAnalysisResult(result.analysis, result.cached))
      onAnalyzed?.(result.analysis.suggestions)
    } catch (e: unknown) {
      setMessage({ text: (e as Error).message ?? "解析に失敗しました", tone: "error" })
    } finally {
      setPhase("idle")
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <button
          onClick={() => void run(false)}
          disabled={phase === "analyzing"}
          className="rounded-md border border-zinc-300 px-3 py-2 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
        >
          {phase === "analyzing" ? "解析中..." : "AI解析する"}
        </button>
        {hasResult && (
          <button
            onClick={() => void run(true)}
            disabled={phase === "analyzing"}
            className="px-2 py-2 text-xs text-zinc-400 hover:text-zinc-700 disabled:opacity-50"
          >
            強制再解析
          </button>
        )}
      </div>
      {message && (
        <p
          className={`mt-1 text-xs ${
            message.tone === "error"
              ? "text-red-500"
              : message.tone === "info"
                ? "text-zinc-500"
                : "text-green-600"
          }`}
        >
          {message.text}
        </p>
      )}
    </div>
  )
}

// ---- Main ----

export default function DetailPanel({
  imageId,
  onClose,
  onDeleted,
  onSuggestionResolved,
  onAnalyzed,
  onTagRemoved,
  onTranslated,
  onPromptSaved,
  hideHeader = false,
  fullWidth = false,
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
    <aside
      className={
        fullWidth
          ? "flex w-full flex-1 flex-col overflow-y-auto bg-white"
          : "flex w-80 flex-shrink-0 flex-col overflow-y-auto border-l border-zinc-200 bg-white"
      }
    >
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
              <div className="mt-1 flex flex-wrap items-start gap-1">
                {state.detail.tags.map((t) => (
                  <TagChip
                    key={t.id}
                    imageId={state.detail.id}
                    tag={t}
                    onRemoved={(tagId) => onTagRemoved?.(tagId)}
                  />
                ))}
              </div>
            </div>
          )}

          <AnalyzeSection imageId={state.detail.id} onAnalyzed={onAnalyzed} />

          {state.detail.tagSuggestions.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">AIタグ候補</p>
              <div className="mt-1.5 flex flex-col gap-2">
                {state.detail.tagSuggestions.map((s) => (
                  <SuggestionCard
                    key={s.id}
                    imageId={state.detail.id}
                    suggestion={s}
                    onResolved={(payload) => onSuggestionResolved?.(payload)}
                  />
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
            <TranslationSection
              imageId={state.detail.id}
              prompt={state.detail.prompt}
              translationEnabled={state.detail.translationEnabled}
              onTranslated={onTranslated}
            />
          )}

          {state.detail.prompt && (
            <PromptEditor
              imageId={state.detail.id}
              prompt={state.detail.prompt}
              onSaved={(updatedPrompt) => {
                dispatch({ type: "update_prompt", prompt: updatedPrompt })
                onPromptSaved?.(updatedPrompt)
              }}
            />
          )}

          {state.detail.prompt && (
            <PromptVariationSection
              imageId={state.detail.id}
              variationEnabled={state.detail.variationEnabled}
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
