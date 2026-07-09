"use client"

import { useEffect, useState } from "react"
import type { GalleryFilters } from "@/lib/gallery/imagesClient"
import { toggleTagId } from "@/lib/gallery/tagFilters"

export type SimpleItem = { id: string; name: string }

/**
 * Shared scene/tag/person option fetch (Phase 10-8B) — used by both the
 * desktop FilterSidebar and the mobile FilterDrawer so each keeps its own
 * copy (only mounted/fetched while actually visible) rather than one
 * component owning state the other needs.
 */
export function useFilterOptions() {
  const [scenes, setScenes] = useState<SimpleItem[]>([])
  const [tags, setTags] = useState<SimpleItem[]>([])
  const [persons, setPersons] = useState<SimpleItem[]>([])

  useEffect(() => {
    void Promise.all([
      fetch("/api/scenes").then((r) => r.json()).then((j: { data?: SimpleItem[] }) => setScenes(j.data ?? [])),
      fetch("/api/tags").then((r) => r.json()).then((j: { data?: SimpleItem[] }) => setTags(j.data ?? [])),
      fetch("/api/persons").then((r) => r.json()).then((j: { data?: SimpleItem[] }) => setPersons(j.data ?? [])),
    ])
  }, [])

  return { scenes, tags, persons }
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

interface FilterContentProps {
  filters: GalleryFilters
  onChange: (patch: Partial<GalleryFilters>) => void
  scenes: SimpleItem[]
  tags: SimpleItem[]
  persons: SimpleItem[]
}

/**
 * Filter body shared by the desktop FilterSidebar and the mobile
 * FilterDrawer (Phase 10-8B) — same markup/logic, different chrome around it.
 */
export default function FilterContent({ filters, onChange, scenes, tags, persons }: FilterContentProps) {
  const hasAnyFilter =
    filters.sceneId !== null ||
    filters.tagIds.length > 0 ||
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
          onClick={() => onChange({ sceneId: null, tagIds: [], personId: null, favorite: null })}
          className="mt-auto rounded border border-zinc-200 px-3 py-1.5 text-xs text-zinc-500 hover:bg-zinc-50"
        >
          フィルタをリセット
        </button>
      )}
    </div>
  )
}
