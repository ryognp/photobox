"use client"

import { useState } from "react"

// Phase 10-18C: selection count, "select all visible", "clear selection".
// Phase 10-18D: "タグを一括追加" / "人物を一括追加" inline action panels wired
// to the existing bulk APIs (POST /api/images/bulk/tags, /persons). This
// component owns only the panel open/close + input/message UI state — the
// actual API calls and detail-state sync live in GalleryClient (passed down
// as onBulkAddTag/onBulkAssignPerson so GalleryClient's reducer stays the
// single source of truth for detail.tags/persons).

type PanelKind = "tag" | "person" | null

type SubmitPhase = "idle" | "submitting" | "error"

interface BulkSelectionToolbarProps {
  selectedCount: number
  visibleCount: number
  onSelectVisible: () => void
  onClear: () => void
  onBulkAddTag: (name: string) => Promise<string>
  onBulkAssignPerson: (name: string) => Promise<string>
}

function ActionPanel({
  label,
  placeholder,
  onSubmit,
  onClose,
}: {
  label: string
  placeholder: string
  onSubmit: (name: string) => Promise<string>
  onClose: () => void
}) {
  const [draft, setDraft] = useState("")
  const [phase, setPhase] = useState<SubmitPhase>("idle")
  const [message, setMessage] = useState<string | null>(null)

  const submit = async () => {
    if (draft.trim() === "") return
    setPhase("submitting")
    setMessage(null)
    try {
      const successMessage = await onSubmit(draft)
      setMessage(successMessage)
      setDraft("")
      setPhase("idle")
    } catch (e: unknown) {
      setMessage((e as Error).message ?? "追加に失敗しました")
      setPhase("error")
    }
  }

  const isSubmitting = phase === "submitting"

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-amber-200 bg-white p-2.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-amber-800">{label}</span>
        <button onClick={onClose} className="text-xs text-zinc-400 hover:text-zinc-700">
          閉じる
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              void submit()
            }
          }}
          disabled={isSubmitting}
          placeholder={placeholder}
          className="min-w-0 flex-1 rounded-md border border-zinc-300 px-2.5 py-1.5 text-xs text-zinc-700 disabled:opacity-50"
        />
        <button
          onClick={() => void submit()}
          disabled={isSubmitting || draft.trim() === ""}
          className="rounded-md border border-amber-400 bg-amber-500 px-2.5 py-1.5 text-xs text-white hover:bg-amber-600 disabled:opacity-50"
        >
          {isSubmitting ? "追加中…" : "追加"}
        </button>
      </div>
      {message && (
        <p className={`text-xs ${phase === "error" ? "text-red-500" : "text-green-700"}`}>{message}</p>
      )}
    </div>
  )
}

export default function BulkSelectionToolbar({
  selectedCount,
  visibleCount,
  onSelectVisible,
  onClear,
  onBulkAddTag,
  onBulkAssignPerson,
}: BulkSelectionToolbarProps) {
  const [openPanel, setOpenPanel] = useState<PanelKind>(null)

  if (selectedCount === 0) return null

  const allVisibleSelected = visibleCount > 0 && selectedCount >= visibleCount

  return (
    <div className="flex flex-col gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 sm:px-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium text-amber-800">選択中: {selectedCount}件</span>
        {!allVisibleSelected && (
          <button
            onClick={onSelectVisible}
            className="rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs text-amber-700 hover:bg-amber-100"
          >
            表示中を全選択
          </button>
        )}
        <button
          onClick={() => setOpenPanel(openPanel === "tag" ? null : "tag")}
          className="rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs text-amber-700 hover:bg-amber-100"
        >
          タグを一括追加
        </button>
        <button
          onClick={() => setOpenPanel(openPanel === "person" ? null : "person")}
          className="rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs text-amber-700 hover:bg-amber-100"
        >
          人物を一括追加
        </button>
        <button
          onClick={onClear}
          className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-600 hover:bg-zinc-50"
        >
          選択解除
        </button>
      </div>

      {openPanel === "tag" && (
        <ActionPanel
          label="タグを一括追加"
          placeholder="タグ名を入力"
          onSubmit={onBulkAddTag}
          onClose={() => setOpenPanel(null)}
        />
      )}
      {openPanel === "person" && (
        <ActionPanel
          label="人物を一括追加"
          placeholder="人物名を入力"
          onSubmit={onBulkAssignPerson}
          onClose={() => setOpenPanel(null)}
        />
      )}
    </div>
  )
}
