"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { checkCommitReadiness } from "@/lib/quick-add/commitReadiness"
import { CommitSummary } from "./_components/CommitSummary"
import { CommitBlockedReasons } from "./_components/CommitBlockedReasons"
import { CommitFilterTabs, FilterTab } from "./_components/CommitFilterTabs"
import CommitItemList from "./_components/CommitItemList"
import DuplicateWarningPanel from "./_components/DuplicateWarningPanel"

interface CommitPreviewClientProps {
  sessionId: string
}

type CommitResultData = {
  summary: {
    requested: number
    committed: number
    skipped: number
    alreadyCommitted: number
    failed: number
    invalid: number
  }
  committed: Array<{ uploadItemId: string; imageId: string; status: string }>
  skipped: Array<{ uploadItemId: string; imageId: string; status: string }>
  alreadyCommitted: Array<{ uploadItemId: string; imageId: string; status: string }>
  failed: Array<{ uploadItemId: string; reason: string; message: string }>
  invalid: Array<{ uploadItemId: string; reason: string; message: string }>
  session: { id: string; status: string }
}

export default function CommitPreviewClient({ sessionId }: CommitPreviewClientProps) {
  const router = useRouter()

  const [items, setItems] = useState<Record<string, unknown>[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [checkingDuplicates, setCheckingDuplicates] = useState(false)
  const [activeTab, setActiveTab] = useState<FilterTab>("all")
  const [committing, setCommitting] = useState(false)
  const [commitResult, setCommitResult] = useState<CommitResultData | null>(null)
  const [commitError, setCommitError] = useState<string | null>(null)
  const [sessionCommitted, setSessionCommitted] = useState(false)

  useEffect(() => {
    let cancelled = false

    const fetchSession = async () => {
      try {
        const res = await fetch(`/api/uploads/session/${sessionId}`)
        if (!res.ok) {
          if (res.status === 404) {
            if (!cancelled) setError("セッションが見つかりません")
          } else if (res.status === 403) {
            if (!cancelled) setError("このセッションへのアクセス権がありません")
          } else {
            if (!cancelled) setError("セッションの読み込みに失敗しました")
          }
          return
        }
        const data = await res.json()
        if (!cancelled) {
          const payload = (data.data ?? data) as Record<string, unknown>
          setItems((payload.items as Record<string, unknown>[] | undefined) ?? [])
          const sessionData = payload.session as Record<string, unknown> | undefined
          if (sessionData?.status === "COMMITTED") {
            setSessionCommitted(true)
          }
        }
      } catch {
        if (!cancelled) setError("ネットワークエラーが発生しました")
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchSession()

    return () => {
      cancelled = true
    }
  }, [sessionId])

  const handleCheckDuplicates = async () => {
    setCheckingDuplicates(true)
    setError(null)
    try {
      const res = await fetch("/api/uploads/check-duplicates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      })
      if (!res.ok) {
        setError("重複チェックに失敗しました")
        return
      }
      const data = await res.json()
      const payload = (data.data ?? data) as Record<string, unknown>
      const updatedItems = (payload.items as Record<string, unknown>[] | undefined) ?? []
      const updatedById = new Map(updatedItems.map((i) => [i.id as string, i]))
      setItems((prev) => prev.map((i) => updatedById.get(i.id as string) ?? i))
    } catch {
      setError("重複チェック中にエラーが発生しました")
    } finally {
      setCheckingDuplicates(false)
    }
  }

  const handleSkip = async (itemId: string) => {
    const res = await fetch(`/api/uploads/items/${itemId}/skip-duplicate`, {
      method: "POST",
    })
    if (!res.ok) {
      throw new Error("スキップに失敗しました")
    }
    const data = await res.json()
    const updated = ((data.data ?? data) as Record<string, unknown>).item as Record<string, unknown>
    setItems((prev) =>
      prev.map((item) => (item.id === itemId ? { ...item, ...updated } : item))
    )
  }

  const handleUnskip = async (itemId: string) => {
    const res = await fetch(`/api/uploads/items/${itemId}/unskip-duplicate`, {
      method: "POST",
    })
    if (!res.ok) {
      return
    }
    const data = await res.json()
    const updated = ((data.data ?? data) as Record<string, unknown>).item as Record<string, unknown>
    setItems((prev) =>
      prev.map((item) => (item.id === itemId ? { ...item, ...updated } : item))
    )
  }

  const handleCommit = async () => {
    setCommitting(true)
    setCommitError(null)
    setCommitResult(null)
    try {
      const res = await fetch("/api/uploads/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      })
      const data = await res.json()
      if (!res.ok) {
        setCommitError(data.error?.message ?? "保存に失敗しました")
        return
      }
      const result = (data.data ?? data) as CommitResultData
      setCommitResult(result)
      if (result.session?.status === "COMMITTED") {
        setSessionCommitted(true)
        try {
          localStorage.removeItem("photobox:active-session")
        } catch {
          // ignore localStorage errors
        }
      }
    } catch {
      setCommitError("ネットワークエラーが発生しました")
    } finally {
      setCommitting(false)
    }
  }

  const handleGoBack = () => {
    router.push("/quick-add")
  }

  const readiness = checkCommitReadiness(items)

  const tabCounts: Record<FilterTab, number> = {
    all: items.length,
    filled: items.filter((i) => (i.promptStatus as string) === "FILLED").length,
    missing: items.filter(
      (i) =>
        (i.promptStatus as string) !== "FILLED" &&
        (i.duplicateStatus as string) !== "SKIPPED"
    ).length,
    duplicate: items.filter((i) => (i.duplicateStatus as string) === "DUPLICATE").length,
    skipped: items.filter((i) => (i.duplicateStatus as string) === "SKIPPED").length,
    error: items.filter((i) => (i.uploadStatus as string) === "ERROR").length,
  }

  const hasDuplicateOrSkipped = items.some(
    (i) =>
      (i.duplicateStatus as string) === "DUPLICATE" ||
      (i.duplicateStatus as string) === "SKIPPED"
  )

  const commitButtonDisabled = !readiness.canCommit || committing || sessionCommitted
  const commitButtonText = committing
    ? "保存中..."
    : sessionCommitted
      ? "保存済み"
      : "確定保存"

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-50">
      {/* Header */}
      <header className="flex items-center gap-4 border-b border-zinc-200 bg-white px-6 py-3">
        <button
          onClick={handleGoBack}
          className="text-sm text-zinc-600 hover:text-zinc-900"
        >
          ← Quick Add へ戻る
        </button>
        <h1 className="text-base font-semibold text-zinc-900">CommitPreview</h1>
        <span className="text-sm text-zinc-500">{sessionId.slice(0, 8)}...</span>
        <div className="ml-auto flex items-center gap-3">
          <button
            onClick={() => void handleCheckDuplicates()}
            disabled={checkingDuplicates || committing}
            className="rounded-md bg-zinc-800 px-3 py-1.5 text-sm text-white hover:bg-zinc-700 disabled:opacity-50"
          >
            {checkingDuplicates ? "チェック中..." : "重複チェック実行"}
          </button>
          <button
            onClick={() => void handleCommit()}
            disabled={commitButtonDisabled}
            className={
              commitButtonDisabled
                ? "cursor-not-allowed rounded-md bg-zinc-400 px-3 py-1.5 text-sm text-white opacity-60"
                : "rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
            }
          >
            {commitButtonText}
          </button>
        </div>
      </header>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: summary + filter + list */}
        <div className="flex flex-1 flex-col gap-4 overflow-hidden p-4">
          {error && <p className="text-sm text-red-600">{error}</p>}
          {loading && <p className="text-sm text-zinc-500">読み込み中...</p>}
          {!loading && items.length > 0 && (
            <>
              <CommitSummary summary={readiness.summary} sessionId={sessionId} />
              <CommitBlockedReasons
                reasons={readiness.reasons}
                canCommit={readiness.canCommit}
              />
              <CommitFilterTabs
                activeTab={activeTab}
                onTabChange={setActiveTab}
                counts={tabCounts}
              />
              <div className="flex-1 overflow-y-auto">
                <CommitItemList
                  items={items}
                  activeTab={activeTab}
                  onSkip={handleSkip}
                  onUnskip={handleUnskip}
                />
              </div>
            </>
          )}
          {!loading && items.length === 0 && !error && (
            <p className="text-zinc-400">アイテムがありません</p>
          )}

          {/* Commit feedback */}
          {commitError && (
            <p className="text-sm text-red-600">エラー: {commitError}</p>
          )}

          {commitResult && (
            <div className="rounded-lg border border-zinc-200 bg-white p-4 flex flex-col gap-3">
              <h2 className="text-sm font-semibold text-zinc-800">保存結果</h2>
              <div className="flex flex-wrap gap-3 text-sm">
                <span className="text-green-700">✓ committed: {commitResult.summary.committed}</span>
                <span className="text-zinc-500">skip: {commitResult.summary.skipped}</span>
                <span className="text-zinc-400">already: {commitResult.summary.alreadyCommitted}</span>
                {commitResult.summary.failed > 0 && (
                  <span className="text-red-600">✗ failed: {commitResult.summary.failed}</span>
                )}
                {commitResult.summary.invalid > 0 && (
                  <span className="text-amber-600">invalid: {commitResult.summary.invalid}</span>
                )}
              </div>
              {commitResult.failed.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-red-600 mb-1">失敗:</p>
                  {commitResult.failed.map((f) => (
                    <p key={f.uploadItemId} className="text-xs text-red-500">
                      {f.uploadItemId}: {f.reason} — {f.message}
                    </p>
                  ))}
                </div>
              )}
              {commitResult.invalid.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-amber-600 mb-1">無効:</p>
                  {commitResult.invalid.map((f) => (
                    <p key={f.uploadItemId} className="text-xs text-amber-500">
                      {f.uploadItemId}: {f.reason}
                    </p>
                  ))}
                </div>
              )}
              {sessionCommitted ? (
                <div className="flex gap-3 mt-1">
                  <button
                    onClick={() => router.push("/gallery")}
                    className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
                  >
                    Gallery へ →
                  </button>
                  <button
                    onClick={() => router.push("/quick-add")}
                    className="rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
                  >
                    新しいセッションを開始
                  </button>
                </div>
              ) : (
                <div className="flex gap-3 mt-1">
                  <button
                    onClick={() => void handleCommit()}
                    disabled={committing}
                    className="rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                  >
                    再試行
                  </button>
                  <button
                    onClick={() => router.push("/quick-add")}
                    className="rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
                  >
                    Quick Add へ戻る
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: DuplicateWarningPanel */}
        {hasDuplicateOrSkipped && (
          <div className="w-80 flex-shrink-0 overflow-y-auto border-l border-zinc-200 bg-white p-4">
            <DuplicateWarningPanel
              items={items}
              onSkip={handleSkip}
              onUnskip={handleUnskip}
            />
          </div>
        )}
      </div>
    </div>
  )
}
