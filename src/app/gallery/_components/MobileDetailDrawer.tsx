"use client"

import { useEffect, useRef } from "react"
import type { ImageDetail, PersonSummary, TagSuggestion, TagSummary, TranslatePromptResult } from "@/lib/gallery/imagesClient"
import { useDialogA11y } from "@/lib/gallery/useDialogA11y"
import DetailPanel, { type SuggestionResolvedPayload } from "./DetailPanel"

interface MobileDetailDrawerProps {
  imageId: string | null
  onClose: () => void
  onDeleted?: (imageId: string) => void
  onSuggestionResolved?: (payload: SuggestionResolvedPayload) => void
  onAnalyzed?: (suggestions: TagSuggestion[]) => void
  onTagRemoved?: (tagId: string) => void
  onTagAdded?: (tag: TagSummary) => void
  onPersonAssigned?: (person: PersonSummary) => void
  onPersonRemoved?: (personId: string) => void
  onTranslated?: (result: TranslatePromptResult) => void
  onPromptSaved?: (prompt: ImageDetail["prompt"]) => void
  /** Phase 10-26B: DetailPanelへそのまま中継する。 */
  isBulkSelected?: boolean
  onToggleBulkSelected?: () => void
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
  onTagAdded,
  onPersonAssigned,
  onPersonRemoved,
  onTranslated,
  onPromptSaved,
  isBulkSelected,
  onToggleBulkSelected,
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

  const panelRef = useRef<HTMLDivElement>(null)
  useDialogA11y({ open: imageId !== null, onClose, containerRef: panelRef })

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
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-detail-drawer-title"
        tabIndex={-1}
        className="fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-2xl bg-white shadow-xl"
        style={{ maxHeight: "90dvh" }}
      >
        {/* Sticky header: pull handle + title + close (stays visible while
            DetailPanel content below scrolls — DetailPanel's own header is
            hidden via hideHeader) */}
        <div className="flex flex-shrink-0 flex-col border-b border-zinc-200">
          <div className="flex justify-center pt-2">
            <div className="h-1 w-10 rounded-full bg-zinc-300" />
          </div>
          <div className="flex items-center justify-between px-4 py-2.5">
            <span id="mobile-detail-drawer-title" className="text-sm font-semibold text-zinc-800">詳細</span>
            <button
              onClick={onClose}
              className="p-1.5 text-zinc-400 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1"
              aria-label="閉じる"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
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
            onTagAdded={onTagAdded}
            onPersonAssigned={onPersonAssigned}
            onPersonRemoved={onPersonRemoved}
            onTranslated={onTranslated}
            onPromptSaved={onPromptSaved}
            isBulkSelected={isBulkSelected}
            onToggleBulkSelected={onToggleBulkSelected}
            hideHeader
            fullWidth
            prefetchedDetail={prefetchedDetail}
            prefetchedLoading={prefetchedLoading}
            prefetchedError={prefetchedError}
          />
        </div>
      </div>
    </div>
  )
}
