"use client"

import { useEffect, useState } from "react"
import type { GalleryFilters } from "@/lib/gallery/imagesClient"
import { toggleTagId } from "@/lib/gallery/tagFilters"

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
}: {
  title: string
  items: SimpleItem[]
  selectedId: string | null
  onSelect: (id: string | null) => void
}) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-500">{title}</p>
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
  selectedIds,
  onToggle,
}: {
  items: SimpleItem[]
  selectedIds: string[]
  onToggle: (id: string) => void
}) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-500">タグ</p>
      {selectedIds.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {selectedIds.map((id) => {
            const item = items.find((i) => i.id === id)
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
export default function FilterContent({ filters, onChange, scenes, tags, persons, suggestionTags }: FilterContentProps) {
  const hasAnyFilter =
    filters.sceneId !== null ||
    filters.tagIds.length > 0 ||
    filters.suggestionLabels.length > 0 ||
    filters.personId !== null ||
    filters.favorite !== null

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

      {scenes.length > 0 && (
        <Section
          title="シーン"
          items={scenes}
          selectedId={filters.sceneId}
          onSelect={(id) => onChange({ sceneId: id })}
        />
      )}

      {tags.length > 0 && (
        <TagFilterSection
          items={tags}
          selectedIds={filters.tagIds}
          onToggle={(id) => onChange({ tagIds: toggleTagId(filters.tagIds, id) })}
        />
      )}

      {suggestionTags.length > 0 && (
        <SuggestionTagFilterSection
          items={suggestionTags}
          selectedLabels={filters.suggestionLabels}
          onToggle={(label) => onChange({ suggestionLabels: toggleLabel(filters.suggestionLabels, label) })}
        />
      )}

      {persons.length > 0 && (
        <Section
          title="人物"
          items={persons}
          selectedId={filters.personId}
          onSelect={(id) => onChange({ personId: id })}
        />
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
