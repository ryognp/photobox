"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { checkCommitReadiness } from "@/lib/quick-add/commitReadiness"
import { deleteUploadItem } from "@/lib/quick-add/itemClient"
import { clearStoredSession } from "@/lib/upload/sessionStore"
import { useFocusOnActivate } from "@/lib/a11y/useFocusOnActivate"
import { CommitSummary } from "./_components/CommitSummary"
import { CommitBlockedReasons } from "./_components/CommitBlockedReasons"
import { CommitFilterTabs, FilterTab } from "./_components/CommitFilterTabs"
import CommitItemList from "./_components/CommitItemList"
import DuplicateWarningPanel from "./_components/DuplicateWarningPanel"
import { CommitResultPanel } from "./_components/CommitResultPanel"

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
  // Phase 10-19A: セッション全体キャンセル(view→confirm→cancelling→error)
  const [cancelPhase, setCancelPhase] = useState<"view" | "confirm" | "cancelling" | "error">("view")
  const [cancelError, setCancelError] = useState<string | null>(null)

  // Phase 10-37-E-B: 各phaseの安全な操作(トリガー/戻る/閉じる)へfocusを戻す。
  // CommitItemCardと同じ理由でrefベース(activeElementキャプチャ方式は使えない)。
  const cancelTriggerRef = useRef<HTMLButtonElement>(null)
  const cancelConfirmBackRef = useRef<HTMLButtonElement>(null)
  const cancelErrorCloseRef = useRef<HTMLButtonElement>(null)
  useFocusOnActivate(cancelPhase === "view", cancelTriggerRef)
  useFocusOnActivate(cancelPhase === "confirm", cancelConfirmBackRef)
  useFocusOnActivate(cancelPhase === "error", cancelErrorCloseRef)

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

  // Phase 10-19A: 個別画像削除。成功時はitemsから除外するのみ(readiness/
  // tabCountsはitemsから毎レンダー再計算されるため自然に更新される)。
  // sessionEmpty(=セッションが0件になりABANDONED化された)ならactive-session
  // localStorageもクリアする(復元不能になったため)。
  const handleDeleteItem = async (itemId: string) => {
    const result = await deleteUploadItem(itemId)
    setItems((prev) => prev.filter((i) => i.id !== itemId))
    if (result.sessionEmpty) {
      clearStoredSession()
    }
  }

  const handleCancelSession = async () => {
    setCancelPhase("cancelling")
    setCancelError(null)
    try {
      const res = await fetch(`/api/uploads/session/${sessionId}`, { method: "DELETE" })
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: { message?: string } }
        throw new Error(data.error?.message ?? "キャンセルに失敗しました")
      }
      clearStoredSession()
      router.push("/quick-add")
    } catch (e: unknown) {
      setCancelError((e as Error).message ?? "キャンセルに失敗しました")
      setCancelPhase("error")
    }
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
    ? "保存中…"
    : sessionCommitted
      ? "保存済み"
      : "確定保存"

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-50">
      {/* Header */}
      <header className="flex flex-wrap items-center gap-4 border-b border-zinc-200 bg-white px-6 py-3">
        <button
          onClick={handleGoBack}
          className="text-sm text-zinc-600 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1"
        >
          ← Quick Add へ戻る
        </button>
        <h1 className="text-base font-semibold text-zinc-900">CommitPreview</h1>
        <span className="text-sm text-zinc-500">{sessionId.slice(0, 8)}…</span>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {/* Phase 10-19A: セッション全体キャンセル */}
          {cancelPhase === "view" && (
            <button
              ref={cancelTriggerRef}
              onClick={() => setCancelPhase("confirm")}
              disabled={committing || sessionCommitted}
              className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1"
            >
              セッションをキャンセル
            </button>
          )}
          {cancelPhase === "confirm" && (
            <div className="flex flex-wrap items-center gap-2">
              <span aria-live="polite" className="text-xs text-red-600">
                このプレビューをキャンセルします。アップロード済みの一時画像は後続のcleanup対象になります。よろしいですか？
              </span>
              <button
                onClick={() => void handleCancelSession()}
                className="rounded-md bg-red-600 px-2.5 py-1 text-xs text-white hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1"
              >
                キャンセルする
              </button>
              <button
                ref={cancelConfirmBackRef}
                onClick={() => setCancelPhase("view")}
                className="text-xs text-zinc-400 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1"
              >
                戻る
              </button>
            </div>
          )}
          {cancelPhase === "cancelling" && (
            <span role="status" className="text-xs text-zinc-400">キャンセル中…</span>
          )}
          {cancelPhase === "error" && (
            <div className="flex flex-wrap items-center gap-2">
              <span role="alert" className="text-xs text-red-500">{cancelError}</span>
              <button
                ref={cancelErrorCloseRef}
                onClick={() => setCancelPhase("view")}
                className="text-xs text-zinc-400 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1"
              >
                閉じる
              </button>
            </div>
          )}
          <button
            onClick={() => void handleCheckDuplicates()}
            disabled={checkingDuplicates || committing}
            className="rounded-md bg-zinc-800 px-3 py-1.5 text-sm text-white hover:bg-zinc-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1"
          >
            {checkingDuplicates ? "チェック中…" : "重複チェック実行"}
          </button>
          <button
            onClick={() => void handleCommit()}
            disabled={commitButtonDisabled}
            className={[
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1",
              commitButtonDisabled
                ? "cursor-not-allowed rounded-md bg-zinc-400 px-3 py-1.5 text-sm text-white opacity-60"
                : "rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700",
            ].join(" ")}
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
          {loading && <p className="text-sm text-zinc-500">読み込み中…</p>}
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
                  onDelete={handleDeleteItem}
                  deleteDisabled={committing || sessionCommitted}
                />
              </div>
            </>
          )}
          {!loading && items.length === 0 && !error && (
            <p className="text-zinc-400">アイテムがありません</p>
          )}

          {/* Commit feedback */}
          {commitError && (
            <p role="alert" className="text-sm text-red-600">エラー: {commitError}</p>
          )}

          {commitResult && (
            <CommitResultPanel
              result={commitResult}
              sessionCommitted={sessionCommitted}
              committing={committing}
              items={items}
              onRetry={() => void handleCommit()}
              onGoGallery={(url) => router.push(url)}
              onNewSession={() => router.push("/quick-add")}
            />
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
