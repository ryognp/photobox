"use client"

// Phase 10-18C: Gallery multi-select toolbar. Shown only when 1+ images are
// bulk-selected. This phase provides the selection count, "select all visible"
// and "clear selection" only — the actual bulk tag/person action buttons are
// added in Phase 10-18D (they are NOT rendered/disabled here to avoid a
// dead-end affordance).

interface BulkSelectionToolbarProps {
  selectedCount: number
  visibleCount: number
  onSelectVisible: () => void
  onClear: () => void
}

export default function BulkSelectionToolbar({
  selectedCount,
  visibleCount,
  onSelectVisible,
  onClear,
}: BulkSelectionToolbarProps) {
  if (selectedCount === 0) return null

  const allVisibleSelected = visibleCount > 0 && selectedCount >= visibleCount

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 sm:px-5">
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
        onClick={onClear}
        className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-600 hover:bg-zinc-50"
      >
        選択解除
      </button>
    </div>
  )
}
