"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { fetchPersons, fetchTags, type PersonSummary, type TagSummary } from "@/lib/gallery/imagesClient"
import { filterPersonsForBulkSelect } from "@/lib/gallery/personSelectFilter"
import { filterTagsForBulkSelect } from "@/lib/gallery/tagSelectFilter"

// Phase 10-18C: selection count, "select all visible", "clear selection".
// Phase 10-18D: "タグを一括追加" / "人物を一括追加" inline action panels wired
// to the existing bulk APIs (POST /api/images/bulk/tags, /persons). This
// component owns only the panel open/close + input/message UI state — the
// actual API calls and detail-state sync live in GalleryClient (passed down
// as onBulkAddTag/onBulkAssignPerson so GalleryClient's reducer stays the
// single source of truth for detail.tags/persons).
// Phase 10-21A: "人物を一括追加" は自由入力ではなく、既存Person一覧から選ぶ
// PersonSelectPanel に変更。
// Phase 10-22A: "タグを一括追加" も既存Tag一覧から選べるTagSelectPanelに
// 変更(既存Tag select + 新規タグ自由入力の両方を1つのpanelに持たせる —
// 自由入力機能は完全には消さない)。onBulkAddTag/onBulkAssignPersonの型
// (name: string)は変更しない — 選択したtag.name/person.nameをそのまま
// 既存bulk API(find-or-create)へ渡すだけで要望を満たす。
// Phase 10-22B: toolbar全体を sticky top-0 化し、画像を下までスクロールした
// 状態でも一括操作(タグ/人物追加・選択解除)が使えるようにする。

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

type TagFetchState =
  | { phase: "loading" }
  | { phase: "ok"; tags: TagSummary[] }
  | { phase: "error"; message: string }

function TagSelectPanel({
  onSubmit,
  onClose,
}: {
  onSubmit: (name: string) => Promise<string>
  onClose: () => void
}) {
  const [fetchState, setFetchState] = useState<TagFetchState>({ phase: "loading" })
  const [query, setQuery] = useState("")
  const [selectedId, setSelectedId] = useState("")
  const [newTagDraft, setNewTagDraft] = useState("")
  const [phase, setPhase] = useState<SubmitPhase>("idle")
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchTags()
      .then((tags) => {
        if (!cancelled) setFetchState({ phase: "ok", tags })
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setFetchState({ phase: "error", message: (e as Error).message ?? "タグ一覧の取得に失敗しました" })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  // person側と同じ方針: 検索queryで絞り込んだ後の候補(filteredTags)を唯一の
  // 真実として扱う。selectedIdが絞り込みで候補から外れた場合は送信できない。
  const filteredTags = fetchState.phase === "ok" ? filterTagsForBulkSelect(fetchState.tags, query) : []
  const selectedTag = filteredTags.find((t) => t.id === selectedId) ?? null

  const submitExisting = async () => {
    if (!selectedTag) return
    setPhase("submitting")
    setMessage(null)
    try {
      const successMessage = await onSubmit(selectedTag.name)
      setMessage(successMessage)
      setSelectedId("")
      setPhase("idle")
    } catch (e: unknown) {
      setMessage((e as Error).message ?? "追加に失敗しました")
      setPhase("error")
    }
  }

  const submitNew = async () => {
    if (newTagDraft.trim() === "") return
    setPhase("submitting")
    setMessage(null)
    try {
      const successMessage = await onSubmit(newTagDraft)
      setMessage(successMessage)
      setNewTagDraft("")
      setPhase("idle")
    } catch (e: unknown) {
      setMessage((e as Error).message ?? "追加に失敗しました")
      setPhase("error")
    }
  }

  const isSubmitting = phase === "submitting"

  return (
    <div className="flex flex-col gap-2 rounded-md border border-amber-200 bg-white p-2.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-amber-800">タグを一括追加</span>
        <button onClick={onClose} className="min-h-10 px-2 text-xs text-zinc-400 hover:text-zinc-700">
          閉じる
        </button>
      </div>

      {fetchState.phase === "loading" && (
        <p className="text-xs text-zinc-400">読み込み中...</p>
      )}

      {fetchState.phase === "error" && (
        <p className="text-xs text-red-500">{fetchState.message}</p>
      )}

      {fetchState.phase === "ok" && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">
            既存タグから選択
          </span>
          {fetchState.tags.length === 0 ? (
            <div className="flex flex-col gap-1">
              <p className="text-xs text-zinc-500">
                登録済みのタグがありません。新しいタグ名を入力して追加できます。
              </p>
              <Link href="/masters?tab=tags" className="text-xs text-blue-600 hover:underline">
                タグを管理 →
              </Link>
            </div>
          ) : (
            <>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                disabled={isSubmitting}
                placeholder="タグ名で検索"
                className="min-h-10 rounded-md border border-zinc-300 px-2.5 py-1.5 text-xs text-zinc-700 disabled:opacity-50"
              />
              <div className="flex flex-wrap gap-1.5">
                <select
                  value={selectedId}
                  onChange={(e) => setSelectedId(e.target.value)}
                  disabled={isSubmitting}
                  className="min-h-10 min-w-0 flex-1 rounded-md border border-zinc-300 px-2.5 py-1.5 text-xs text-zinc-700 disabled:opacity-50"
                >
                  <option value="">タグを選択</option>
                  {filteredTags.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => void submitExisting()}
                  disabled={isSubmitting || !selectedTag}
                  className="min-h-10 rounded-md border border-amber-400 bg-amber-500 px-2.5 py-1.5 text-xs text-white hover:bg-amber-600 disabled:opacity-50"
                >
                  {isSubmitting ? "追加中…" : "追加"}
                </button>
              </div>
              {filteredTags.length === 0 && (
                <p className="text-xs text-zinc-400">該当するタグがありません</p>
              )}
            </>
          )}
        </div>
      )}

      <div className="flex flex-col gap-1.5 border-t border-zinc-100 pt-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">
          新しいタグを入力
        </span>
        <div className="flex flex-wrap gap-1.5">
          <input
            type="text"
            value={newTagDraft}
            onChange={(e) => setNewTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                void submitNew()
              }
            }}
            disabled={isSubmitting}
            placeholder="新しいタグ名を入力"
            className="min-h-10 min-w-0 flex-1 rounded-md border border-zinc-300 px-2.5 py-1.5 text-xs text-zinc-700 disabled:opacity-50"
          />
          <button
            onClick={() => void submitNew()}
            disabled={isSubmitting || newTagDraft.trim() === ""}
            className="min-h-10 rounded-md border border-amber-400 bg-amber-500 px-2.5 py-1.5 text-xs text-white hover:bg-amber-600 disabled:opacity-50"
          >
            {isSubmitting ? "追加中…" : "新規タグを追加"}
          </button>
        </div>
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

  // レビュー修正: 検索queryで絞り込んだ後の候補(filteredPersons)を唯一の
  // 真実として扱う。selectedIdが絞り込みで候補から外れた場合、selectedPerson
  // はnullになり、送信ボタンがdisabledになる(stateに古いselectedIdが残って
  // いても、見えている候補にない人物は送信できない)。
  const filteredPersons = fetchState.phase === "ok" ? filterPersonsForBulkSelect(fetchState.persons, query) : []
  const selectedPerson = filteredPersons.find((p) => p.id === selectedId) ?? null

  const submit = async () => {
    if (!selectedPerson) return
    setPhase("submitting")
    setMessage(null)
    try {
      const successMessage = await onSubmit(selectedPerson.name)
      setMessage(successMessage)
      setSelectedId("")
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
        <button onClick={onClose} className="min-h-10 px-2 text-xs text-zinc-400 hover:text-zinc-700">
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
            className="min-h-10 rounded-md border border-zinc-300 px-2.5 py-1.5 text-xs text-zinc-700 disabled:opacity-50"
          />
          <div className="flex flex-wrap gap-1.5">
            <select
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              disabled={isSubmitting}
              className="min-h-10 min-w-0 flex-1 rounded-md border border-zinc-300 px-2.5 py-1.5 text-xs text-zinc-700 disabled:opacity-50"
            >
              <option value="">人物を選択</option>
              {filteredPersons.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              onClick={() => void submit()}
              disabled={isSubmitting || !selectedPerson}
              className="min-h-10 rounded-md border border-amber-400 bg-amber-500 px-2.5 py-1.5 text-xs text-white hover:bg-amber-600 disabled:opacity-50"
            >
              {isSubmitting ? "追加中…" : "追加"}
            </button>
          </div>
          {filteredPersons.length === 0 && (
            <p className="text-xs text-zinc-400">該当する人物がありません</p>
          )}
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
    <div className="sticky top-0 z-20 flex flex-col gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 sm:px-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium text-amber-800">選択中: {selectedCount}件</span>
        {!allVisibleSelected && (
          <button
            onClick={onSelectVisible}
            className="min-h-10 rounded-md border border-amber-300 bg-white px-3 py-2 text-xs text-amber-700 hover:bg-amber-100"
          >
            表示中を全選択
          </button>
        )}
        <button
          onClick={() => setOpenPanel(openPanel === "tag" ? null : "tag")}
          className="min-h-10 rounded-md border border-amber-300 bg-white px-3 py-2 text-xs text-amber-700 hover:bg-amber-100"
        >
          タグを一括追加
        </button>
        <button
          onClick={() => setOpenPanel(openPanel === "person" ? null : "person")}
          className="min-h-10 rounded-md border border-amber-300 bg-white px-3 py-2 text-xs text-amber-700 hover:bg-amber-100"
        >
          人物を一括追加
        </button>
        <button
          onClick={onClear}
          className="min-h-10 rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs text-zinc-600 hover:bg-zinc-50"
        >
          選択解除
        </button>
      </div>

      {openPanel === "tag" && (
        <TagSelectPanel
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
