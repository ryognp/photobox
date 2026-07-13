"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { fetchPersons, type PersonSummary } from "@/lib/gallery/imagesClient"
import { filterPersonsForBulkSelect } from "@/lib/gallery/personSelectFilter"

// Phase 10-18C: selection count, "select all visible", "clear selection".
// Phase 10-18D: "タグを一括追加" / "人物を一括追加" inline action panels wired
// to the existing bulk APIs (POST /api/images/bulk/tags, /persons). This
// component owns only the panel open/close + input/message UI state — the
// actual API calls and detail-state sync live in GalleryClient (passed down
// as onBulkAddTag/onBulkAssignPerson so GalleryClient's reducer stays the
// single source of truth for detail.tags/persons).
// Phase 10-21A: "人物を一括追加" は自由入力ではなく、既存Person一覧から選ぶ
// PersonSelectPanel に変更(タグ側のActionPanelは自由入力のまま維持)。
// onBulkAssignPerson の型(name: string)は変更しない — 選択したperson.name
// をそのまま既存bulk API(find-or-create)へ渡すだけで要望を満たす。

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

type PersonFetchState =
  | { phase: "loading" }
  | { phase: "ok"; persons: PersonSummary[] }
  | { phase: "error"; message: string }

function PersonSelectPanel({
  onSubmit,
  onClose,
}: {
  onSubmit: (name: string) => Promise<string>
  onClose: () => void
}) {
  const [fetchState, setFetchState] = useState<PersonFetchState>({ phase: "loading" })
  const [query, setQuery] = useState("")
  const [selectedId, setSelectedId] = useState("")
  const [phase, setPhase] = useState<SubmitPhase>("idle")
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchPersons()
      .then((persons) => {
        if (!cancelled) setFetchState({ phase: "ok", persons })
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setFetchState({ phase: "error", message: (e as Error).message ?? "人物一覧の取得に失敗しました" })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  const submit = async () => {
    if (fetchState.phase !== "ok") return
    const person = fetchState.persons.find((p) => p.id === selectedId)
    if (!person) return
    setPhase("submitting")
    setMessage(null)
    try {
      const successMessage = await onSubmit(person.name)
      setMessage(successMessage)
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
        <span className="text-xs font-semibold text-amber-800">人物を一括追加</span>
        <button onClick={onClose} className="text-xs text-zinc-400 hover:text-zinc-700">
          閉じる
        </button>
      </div>

      {fetchState.phase === "loading" && (
        <p className="text-xs text-zinc-400">読み込み中...</p>
      )}

      {fetchState.phase === "error" && (
        <p className="text-xs text-red-500">{fetchState.message}</p>
      )}

      {fetchState.phase === "ok" && fetchState.persons.length === 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-zinc-500">
            登録済みの人物がありません。先に人物マスターを追加してください。
          </p>
          <Link href="/masters?tab=persons" className="text-xs text-blue-600 hover:underline">
            人物を管理 →
          </Link>
        </div>
      )}

      {fetchState.phase === "ok" && fetchState.persons.length > 0 && (
        <>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={isSubmitting}
            placeholder="人物名で検索"
            className="rounded-md border border-zinc-300 px-2.5 py-1.5 text-xs text-zinc-700 disabled:opacity-50"
          />
          <div className="flex flex-wrap gap-1.5">
            <select
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              disabled={isSubmitting}
              className="min-w-0 flex-1 rounded-md border border-zinc-300 px-2.5 py-1.5 text-xs text-zinc-700 disabled:opacity-50"
            >
              <option value="">人物を選択</option>
              {filterPersonsForBulkSelect(fetchState.persons, query).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              onClick={() => void submit()}
              disabled={isSubmitting || selectedId === ""}
              className="rounded-md border border-amber-400 bg-amber-500 px-2.5 py-1.5 text-xs text-white hover:bg-amber-600 disabled:opacity-50"
            >
              {isSubmitting ? "追加中…" : "追加"}
            </button>
          </div>
        </>
      )}

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
        <PersonSelectPanel
          onSubmit={onBulkAssignPerson}
          onClose={() => setOpenPanel(null)}
        />
      )}
    </div>
  )
}
