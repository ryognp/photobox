"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import type { GalleryFilters } from "@/lib/gallery/imagesClient"
import { toggleTagId } from "@/lib/gallery/tagFilters"
import { filterTagsForBulkSelect } from "@/lib/gallery/tagSelectFilter"
import { filterPersonsForBulkSelect } from "@/lib/gallery/personSelectFilter"

export type SimpleItem = { id: string; name: string }
/** AI candidate tag option (Phase 10-9B): keyed by label, not id. */
export type SuggestionTagItem = { label: string; imageCount: number }

/**
 * Shared scene/tag/person/AI-candidate option fetch (Phase 10-8B / 10-9B) —
 * used by both the desktop FilterSidebar and the mobile FilterDrawer so each
 * keeps its own copy (only mounted/fetched while actually visible) rather than
 * one component owning state the other needs.
 */
export function useFilterOptions() {
  const [scenes, setScenes] = useState<SimpleItem[]>([])
  const [tags, setTags] = useState<SimpleItem[]>([])
  const [persons, setPersons] = useState<SimpleItem[]>([])
  const [suggestionTags, setSuggestionTags] = useState<SuggestionTagItem[]>([])

  useEffect(() => {
    void Promise.all([
      fetch("/api/scenes").then((r) => r.json()).then((j: { data?: SimpleItem[] }) => setScenes(j.data ?? [])),
      fetch("/api/tags").then((r) => r.json()).then((j: { data?: SimpleItem[] }) => setTags(j.data ?? [])),
      fetch("/api/persons").then((r) => r.json()).then((j: { data?: SimpleItem[] }) => setPersons(j.data ?? [])),
      fetch("/api/tag-suggestions").then((r) => r.json()).then((j: { data?: SuggestionTagItem[] }) => setSuggestionTags(j.data ?? [])),
    ])
  }, [])

  return { scenes, tags, persons, suggestionTags }
}

function Section({
  title,
  items,
  selectedId,
  onSelect,
  query,
  onQueryChange,
  searchPlaceholder,
  emptyMessage,
}: {
  title: string
  items: SimpleItem[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  query: string
  onQueryChange: (value: string) => void
  searchPlaceholder: string
  emptyMessage: string
}) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-500">{title}</p>
      <input
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder={searchPlaceholder}
        className="mb-1.5 min-h-10 w-full rounded border border-zinc-300 px-2 py-1 text-sm text-zinc-700"
      />
      <div className="flex flex-col gap-0.5">
        <button
          onClick={() => onSelect(null)}
          className={`rounded px-2 py-1 text-left text-sm ${
            selectedId === null
              ? "bg-blue-50 font-medium text-blue-700"
              : "text-zinc-700 hover:bg-zinc-100"
          }`}
        >
          すべて
        </button>
        {items.map((item) => (
          <button
            key={item.id}
            onClick={() => onSelect(selectedId === item.id ? null : item.id)}
            className={`truncate rounded px-2 py-1 text-left text-sm ${
              selectedId === item.id
                ? "bg-blue-50 font-medium text-blue-700"
                : "text-zinc-700 hover:bg-zinc-100"
            }`}
          >
            {item.name}
          </button>
        ))}
        {items.length === 0 && (
          <p className="px-2 py-1 text-xs text-zinc-400">{emptyMessage}</p>
        )}
      </div>
    </div>
  )
}

/**
 * Multi-select tag filter (Phase 10-7B, AND semantics — an image must have
 * ALL selected tags). Selected tags render as removable chips above the
 * toggleable list.
 */
function TagFilterSection({
  items,
  allItems,
  selectedIds,
  onToggle,
  query,
  onQueryChange,
}: {
  /** Search-filtered list to display as the toggle list. */
  items: SimpleItem[]
  /** Full (unfiltered) list, used to resolve selected chip labels even when
   *  the search query hides the selected tag from the toggle list below. */
  allItems: SimpleItem[]
  selectedIds: string[]
  onToggle: (id: string) => void
  query: string
  onQueryChange: (value: string) => void
}) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-500">タグ</p>
      {selectedIds.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {selectedIds.map((id) => {
            const item = allItems.find((i) => i.id === id)
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700"
              >
                {item?.name ?? id}
                <button
                  onClick={() => onToggle(id)}
                  aria-label={`${item?.name ?? id} を解除`}
                  className="text-blue-500 hover:text-blue-800"
                >
                  ×
                </button>
              </span>
            )
          })}
        </div>
      )}
      <input
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="タグ名で検索"
        className="mb-1.5 min-h-10 w-full rounded border border-zinc-300 px-2 py-1 text-sm text-zinc-700"
      />
      <div className="flex flex-col gap-0.5">
        {items.map((item) => {
          const selected = selectedIds.includes(item.id)
          return (
            <button
              key={item.id}
              onClick={() => onToggle(item.id)}
              className={`truncate rounded px-2 py-1 text-left text-sm ${
                selected ? "bg-blue-50 font-medium text-blue-700" : "text-zinc-700 hover:bg-zinc-100"
              }`}
            >
              {selected ? "✓ " : ""}{item.name}
            </button>
          )
        })}
        {items.length === 0 && (
          <p className="px-2 py-1 text-xs text-zinc-400">該当するタグがありません</p>
        )}
      </div>
    </div>
  )
}

/** Toggle a label in a string[] (add if absent, remove if present). */
function toggleLabel(labels: string[], label: string): string[] {
  return labels.includes(label) ? labels.filter((l) => l !== label) : [...labels, label]
}

/**
 * AI-candidate (PENDING) tag filter (Phase 10-9B, AND semantics). Kept
 * visually distinct from approved tags via an "AI候補" badge. Keyed by label.
 */
function SuggestionTagFilterSection({
  items,
  selectedLabels,
  onToggle,
}: {
  items: SuggestionTagItem[]
  selectedLabels: string[]
  onToggle: (label: string) => void
}) {
  return (
    <div>
      <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-500">
        AI候補タグ
        <span className="rounded bg-amber-100 px-1 py-0.5 text-[10px] font-medium normal-case tracking-normal text-amber-700">
          AI候補
        </span>
      </p>
      {selectedLabels.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {selectedLabels.map((label) => (
            <span
              key={label}
              className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700"
            >
              {label}
              <button
                onClick={() => onToggle(label)}
                aria-label={`${label} を解除`}
                className="text-amber-500 hover:text-amber-800"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-0.5">
        {items.map((item) => {
          const selected = selectedLabels.includes(item.label)
          return (
            <button
              key={item.label}
              onClick={() => onToggle(item.label)}
              className={`truncate rounded px-2 py-1 text-left text-sm ${
                selected ? "bg-amber-50 font-medium text-amber-700" : "text-zinc-700 hover:bg-zinc-100"
              }`}
            >
              {selected ? "✓ " : ""}{item.label}
              <span className="ml-1 text-xs text-zinc-400">({item.imageCount})</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

interface FilterContentProps {
  filters: GalleryFilters
  onChange: (patch: Partial<GalleryFilters>) => void
  scenes: SimpleItem[]
  tags: SimpleItem[]
  persons: SimpleItem[]
  suggestionTags: SuggestionTagItem[]
}

/**
 * Filter body shared by the desktop FilterSidebar and the mobile
 * FilterDrawer (Phase 10-8B) — same markup/logic, different chrome around it.
 */
export default function FilterContent({ filters, onChange, tags, persons, suggestionTags }: FilterContentProps) {
  const hasAnyFilter =
    filters.sceneId !== null ||
    filters.tagIds.length > 0 ||
    filters.suggestionLabels.length > 0 ||
    filters.personId !== null ||
    filters.favorite !== null

  // Phase 10-25C: client-side search-the-filter-list, scoped to this
  // component only (no URL/filter state change — selection itself is
  // unaffected by the search query, only which items are shown below).
  const [tagQuery, setTagQuery] = useState("")
  const [personQuery, setPersonQuery] = useState("")
  const filteredTags = filterTagsForBulkSelect(tags, tagQuery)
  const filteredPersons = filterPersonsForBulkSelect(persons, personQuery)

  return (
    <div className="flex flex-1 flex-col gap-5">
      {/* Favorite */}
      <div>
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-500">お気に入り</p>
        <button
          onClick={() => onChange({ favorite: filters.favorite === true ? null : true })}
          className={`flex items-center gap-1.5 rounded px-2 py-1 text-sm ${
            filters.favorite === true
              ? "bg-yellow-50 font-medium text-yellow-700"
              : "text-zinc-700 hover:bg-zinc-100"
          }`}
        >
          <span>★</span> お気に入りのみ
        </button>
      </div>

      {/* Sort */}
      <div>
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-500">並び順</p>
        <div className="flex flex-col gap-0.5">
          {(["newest", "oldest"] as const).map((s) => (
            <button
              key={s}
              onClick={() => onChange({ sort: s })}
              className={`rounded px-2 py-1 text-left text-sm ${
                filters.sort === s
                  ? "bg-blue-50 font-medium text-blue-700"
                  : "text-zinc-700 hover:bg-zinc-100"
              }`}
            >
              {s === "newest" ? "新しい順" : "古い順"}
            </button>
          ))}
        </div>
      </div>

      {/* Phase 10-14A: シーンフィルターUIは運用上不要になったため非表示。
          filters.sceneId / scenes fetch はclient型・URL互換のため残す
          (破壊的変更を避ける) — UIとして描画しないだけ。 */}

      {tags.length > 0 && (
        <TagFilterSection
          items={filteredTags}
          allItems={tags}
          selectedIds={filters.tagIds}
          onToggle={(id) => onChange({ tagIds: toggleTagId(filters.tagIds, id) })}
          query={tagQuery}
          onQueryChange={setTagQuery}
        />
      )}

      {/* Phase 10-20A: タグ本体の追加/削除/rename/mergeは/mastersで行う。
          Gallery側から見つけやすいよう管理画面への導線を用意する。 */}
      <Link
        href="/masters?tab=tags"
        className="text-xs text-blue-600 hover:underline"
      >
        タグを管理 →
      </Link>

      {suggestionTags.length > 0 && (
        <SuggestionTagFilterSection
          items={suggestionTags}
          selectedLabels={filters.suggestionLabels}
          onToggle={(label) => onChange({ suggestionLabels: toggleLabel(filters.suggestionLabels, label) })}
        />
      )}

      {persons.length > 0 && (
        <>
          <Section
            title="人物"
            items={filteredPersons}
            selectedId={filters.personId}
            onSelect={(id) => onChange({ personId: id })}
            query={personQuery}
            onQueryChange={setPersonQuery}
            searchPlaceholder="人物名で検索"
            emptyMessage="該当する人物がありません"
          />
          {/* Phase 10-25C: 人物マスターへの管理導線(タグ側の既存導線と対称に)。 */}
          <Link
            href="/masters?tab=persons"
            className="text-xs text-blue-600 hover:underline"
          >
            人物を管理 →
          </Link>
        </>
      )}

      {hasAnyFilter && (
        <button
          onClick={() => onChange({ sceneId: null, tagIds: [], suggestionLabels: [], personId: null, favorite: null })}
          className="mt-auto rounded border border-zinc-200 px-3 py-1.5 text-xs text-zinc-500 hover:bg-zinc-50"
        >
          フィルタをリセット
        </button>
      )}
    </div>
  )
}
