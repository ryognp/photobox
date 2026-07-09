"use client"

import { useEffect } from "react"
import type { GalleryFilters } from "@/lib/gallery/imagesClient"
import FilterContent, { useFilterOptions } from "./FilterContent"

interface MobileFilterDrawerProps {
  open: boolean
  filters: GalleryFilters
  onChange: (patch: Partial<GalleryFilters>) => void
  onClose: () => void
}

/**
 * Mobile filter bottom sheet (Phase 10-8B). Exclusive with MobileDetailDrawer
 * — GalleryClient closes the detail drawer when this opens, and closes this
 * when an image is selected (see GalleryClient's filterDrawerOpen wiring).
 * Filter changes do NOT close the drawer (multi-select is easier that way);
 * the user closes it explicitly via × or "完了".
 */
export default function MobileFilterDrawer({ open, filters, onChange, onClose }: MobileFilterDrawerProps) {
  const options = useFilterOptions()

  // body scroll lock while open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden"
    } else {
      document.body.style.overflow = ""
    }
    return () => {
      document.body.style.overflow = ""
    }
  }, [open])

  if (!open) return null

  return (
    // md以上では非表示
    <div className="md:hidden">
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} aria-hidden="true" />

      {/* Drawer panel */}
      <div
        className="fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-2xl bg-white shadow-xl"
        style={{ maxHeight: "85dvh" }}
      >
        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-zinc-200 px-4 py-3">
          <span className="text-sm font-semibold text-zinc-800">フィルター</span>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700" aria-label="フィルターを閉じる">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          <FilterContent filters={filters} onChange={onChange} {...options} />
        </div>

        {/* Footer: explicit close, since filter changes don't auto-close */}
        <div className="flex-shrink-0 border-t border-zinc-200 p-3">
          <button
            onClick={onClose}
            className="w-full rounded-md bg-zinc-800 px-3 py-2.5 text-center text-sm font-medium text-white hover:bg-zinc-600"
          >
            完了
          </button>
        </div>
      </div>
    </div>
  )
}
