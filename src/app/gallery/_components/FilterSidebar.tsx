"use client"

import type { GalleryFilters } from "@/lib/gallery/imagesClient"
import type { GalleryDensity } from "@/lib/gallery/galleryDensity"
import FilterContent, { useFilterOptions } from "./FilterContent"

interface FilterSidebarProps {
  filters: GalleryFilters
  onChange: (patch: Partial<GalleryFilters>) => void
  /** Phase 10-27B: passed through for FilterContent's prop type — the
   *  density section itself is md:hidden, so it never renders here (desktop
   *  uses the GalleryClient header switch instead). */
  density: GalleryDensity
  onDensityChange: (density: GalleryDensity) => void
}

/**
 * Desktop filter sidebar (Phase 10-8B: breakpoint moved from sm to md so it
 * lines up exactly with MobileDetailDrawer/MobileFilterDrawer's md:hidden —
 * no width range shows both the sidebar and a mobile drawer at once).
 */
export default function FilterSidebar({ filters, onChange, density, onDensityChange }: FilterSidebarProps) {
  const options = useFilterOptions()

  return (
    <aside className="hidden md:flex w-52 flex-shrink-0 flex-col overflow-y-auto border-r border-zinc-200 bg-white p-4">
      <FilterContent
        filters={filters}
        onChange={onChange}
        density={density}
        onDensityChange={onDensityChange}
        {...options}
      />
    </aside>
  )
}
