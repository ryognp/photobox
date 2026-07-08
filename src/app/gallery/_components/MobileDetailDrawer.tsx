"use client"

import { useEffect } from "react"
import type { ImageDetail, TagSuggestion } from "@/lib/gallery/imagesClient"
import DetailPanel, { type SuggestionResolvedPayload } from "./DetailPanel"

interface MobileDetailDrawerProps {
  imageId: string | null
  onClose: () => void
  onDeleted?: (imageId: string) => void
  onSuggestionResolved?: (payload: SuggestionResolvedPayload) => void
  onAnalyzed?: (suggestions: TagSuggestion[]) => void
  onTagRemoved?: (tagId: string) => void
  prefetchedDetail?: ImageDetail | null
  prefetchedLoading?: boolean
  prefetchedError?: string | null
}

export default function MobileDetailDrawer({
  imageId,
  onClose,
  onDeleted,
  onSuggestionResolved,
  onAnalyzed,
  onTagRemoved,
  prefetchedDetail,
  prefetchedLoading,
  prefetchedError,
}: MobileDetailDrawerProps) {
  // body scroll lock while open
  useEffect(() => {
    if (imageId) {
      document.body.style.overflow = "hidden"
    } else {
      document.body.style.overflow = ""
    }
    return () => {
      document.body.style.overflow = ""
    }
  }, [imageId])

  if (!imageId) return null

  return (
    // md以上では非表示
    <div className="md:hidden">
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/50"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer panel */}
      <div
        className="fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-2xl bg-white shadow-xl"
        style={{ maxHeight: "90dvh" }}
      >
        {/* Pull handle */}
        <div className="flex flex-shrink-0 justify-center py-2">
          <div className="h-1 w-10 rounded-full bg-zinc-300" />
        </div>

        {/* DetailPanel with prefetched data (no extra fetch) */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <DetailPanel
            imageId={imageId}
            onClose={onClose}
            onDeleted={onDeleted}
            onSuggestionResolved={onSuggestionResolved}
            onAnalyzed={onAnalyzed}
            onTagRemoved={onTagRemoved}
            prefetchedDetail={prefetchedDetail}
            prefetchedLoading={prefetchedLoading}
            prefetchedError={prefetchedError}
          />
        </div>
      </div>
    </div>
  )
}
