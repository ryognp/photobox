"use client"

import { useEffect, useState } from "react"
import type { GalleryFilters } from "@/lib/gallery/imagesClient"

type SimpleItem = { id: string; name: string }

interface FilterSidebarProps {
  filters: GalleryFilters
  onChange: (patch: Partial<GalleryFilters>) => void
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

export default function FilterSidebar({ filters, onChange }: FilterSidebarProps) {
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

  const hasAnyFilter =
    filters.sceneId !== null ||
    filters.tagId !== null ||
    filters.personId !== null ||
    filters.favorite !== null

  return (
    <aside className="hidden sm:flex w-52 flex-shrink-0 flex-col gap-5 overflow-y-auto border-r border-zinc-200 bg-white p-4">
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
        <Section
          title="タグ"
          items={tags}
          selectedId={filters.tagId}
          onSelect={(id) => onChange({ tagId: id })}
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
          onClick={() => onChange({ sceneId: null, tagId: null, personId: null, favorite: null })}
          className="mt-auto rounded border border-zinc-200 px-3 py-1.5 text-xs text-zinc-500 hover:bg-zinc-50"
        >
          フィルタをリセット
        </button>
      )}
    </aside>
  )
}
