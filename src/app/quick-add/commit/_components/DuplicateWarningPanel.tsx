"use client"

import { useState } from "react"

type Props = {
  items: Record<string, unknown>[]
  onSkip: (itemId: string) => Promise<void>
  onUnskip: (itemId: string) => Promise<void>
}

type ItemActionState = {
  loading: boolean
  error: string | null
}

export default function DuplicateWarningPanel({ items, onSkip, onUnskip }: Props) {
  const [actionStates, setActionStates] = useState<Record<string, ItemActionState>>({})

  const filtered = items.filter(
    (item) => item.duplicateStatus === "DUPLICATE" || item.duplicateStatus === "SKIPPED"
  )

  if (filtered.length === 0) return null

  const setLoading = (id: string, loading: boolean) => {
    setActionStates((prev) => ({
      ...prev,
      [id]: { loading, error: prev[id]?.error ?? null },
    }))
  }

  const setError = (id: string, error: string | null) => {
    setActionStates((prev) => ({
      ...prev,
      [id]: { loading: false, error },
    }))
  }

  const handleSkip = async (id: string) => {
    setLoading(id, true)
    setError(id, null)
    try {
      await onSkip(id)
    } catch (e) {
      setError(id, e instanceof Error ? e.message : "エラーが発生しました")
    } finally {
      setLoading(id, false)
    }
  }

  const handleUnskip = async (id: string) => {
    setLoading(id, true)
    setError(id, null)
    try {
      await onUnskip(id)
    } catch (e) {
      setError(id, e instanceof Error ? e.message : "エラーが発生しました")
    } finally {
      setLoading(id, false)
    }
  }

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-amber-600">
        重複候補 ({filtered.length}件)
      </h2>
      <div className="space-y-2">
        {filtered.map((item) => {
          const id = item.id as string
          const state = actionStates[id]
          const isLoading = state?.loading ?? false
          const error = state?.error ?? null
          const isDuplicate = item.duplicateStatus === "DUPLICATE"
          const isSkipped = item.duplicateStatus === "SKIPPED"
          const fileHash = (item.fileHash as string) ?? ""

          return (
            <div
              key={id}
              className="flex items-start gap-3 rounded-lg border border-zinc-200 bg-white p-3"
            >
              {/* Thumbnail placeholder */}
              <div className="h-10 w-10 flex-shrink-0 rounded bg-zinc-200" />

              {/* Info */}
              <div className="min-w-0 flex-1 space-y-1">
                <p className="truncate text-sm font-medium text-zinc-800">
                  {item.originalName as string}
                </p>
                <p className="font-mono text-xs text-zinc-400">
                  {fileHash.slice(0, 12)}
                </p>
                {Boolean(item.duplicateImageId) && (
                  <p className="truncate text-xs text-zinc-400">
                    重複ID: {item.duplicateImageId as string}
                  </p>
                )}
                {Boolean(item.promptStatus) && (
                  <span className="inline-block rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600">
                    {item.promptStatus as string}
                  </span>
                )}
                {error && (
                  <p className="text-xs text-red-500">{error}</p>
                )}
              </div>

              {/* Actions */}
              <div className="flex flex-shrink-0 flex-col items-end gap-1">
                {isDuplicate && (
                  <button
                    onClick={() => handleSkip(id)}
                    disabled={isLoading}
                    className="rounded bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-700 hover:bg-amber-200 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1"
                  >
                    {isLoading ? "…" : "スキップ"}
                  </button>
                )}
                {isSkipped && (
                  <>
                    <span className="text-xs font-medium text-zinc-400">スキップ済み</span>
                    <button
                      onClick={() => handleUnskip(id)}
                      disabled={isLoading}
                      className="rounded bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-200 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1"
                    >
                      {isLoading ? "…" : "解除"}
                    </button>
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
