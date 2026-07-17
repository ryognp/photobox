"use client"

import { useEffect, useRef } from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import type { GalleryImage, GalleryFilters } from "@/lib/gallery/imagesClient"
import {
  buildGalleryScrollStorageKey,
  parseSavedScrollY,
  shouldRestoreScrollY,
  buildGalleryLastVisibleStorageKey,
  parseSavedLastVisibleImageId,
  pickMostVisibleImageId,
  type VisibleImageEntry,
} from "@/lib/gallery/galleryScrollRestoration"
import { getGalleryDensityGridClass, type GalleryDensity } from "@/lib/gallery/galleryDensity"
import type { GallerySort } from "@/lib/gallery/gallerySort"
import ImageCard from "./ImageCard"

interface ImageGridProps {
  images: GalleryImage[]
  selectedId: string | null
  onSelect: (id: string) => void
  bulkSelectedIds: string[]
  onBulkToggle: (imageId: string) => void
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  onLoadMore: () => void
  onRetry: () => void
  error: string | null
  density: GalleryDensity
  /** Phase 10-30B: only "needs_review" carries organization-reason data
   *  (image.isUntagged/isUnpersoned/hasCurrentPendingSuggestions) — used to
   *  gate ImageCard's badge row. */
  sort: GallerySort
  /** Phase 10-31B: passed straight through to ImageCard's organization-reason
   *  badges (click-to-filter-ON). */
  onFilterChange: (patch: Partial<GalleryFilters>) => void
}

export default function ImageGrid({
  images,
  selectedId,
  onSelect,
  bulkSelectedIds,
  onBulkToggle,
  loading,
  loadingMore,
  hasMore,
  onLoadMore,
  onRetry,
  error,
  density,
  sort,
  onFilterChange,
}: ImageGridProps) {
  const bulkSelectedSet = new Set(bulkSelectedIds)
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  // Phase 10-22B: スクロール位置のsessionStorage保存/復元。ImageGrid自身が
  // overflow-y-autoの実スクロールコンテナを持つため、windowではなくこの
  // containerRefに対してscrollTop/scrollイベントを扱う。keyはフィルター
  // (pathname+search)ごとに分け、cursor paginationでまだ読み込まれていない
  // 位置までは無理に復元しない(既知の制約 — 大量の自動追加fetchはしない)。
  const containerRef = useRef<HTMLDivElement>(null)
  const restoredKeyRef = useRef<string | null>(null)
  const storageKey = buildGalleryScrollStorageKey(pathname, searchParams.toString())
  // Phase 10-23B: separate namespace from storageKey (scrollTop) — holds the
  // last-most-visible image id so reload can scrollIntoView it directly.
  const lastVisibleStorageKey = buildGalleryLastVisibleStorageKey(pathname, searchParams.toString())

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    // 復元は同じstorageKeyに対して一度だけ試みる(filter変更でstorageKeyが
    // 変わった場合のみ再度復元を試みる)。優先順位: lastVisibleImageIdが
    // DOM上に見つかればscrollIntoView、見つからなければ既存scrollTop復元。
    if (restoredKeyRef.current !== storageKey) {
      let restoredViaLastVisible = false
      try {
        const lastVisibleId = parseSavedLastVisibleImageId(sessionStorage.getItem(lastVisibleStorageKey))
        if (lastVisibleId !== null) {
          const cards = el.querySelectorAll<HTMLElement>("[data-image-id]")
          for (const card of cards) {
            if (card.dataset.imageId === lastVisibleId) {
              card.scrollIntoView({ block: "center" })
              restoredViaLastVisible = true
              break
            }
          }
        }
      } catch {
        // sessionStorage unavailable (private mode等) — フォールバックへ続行
      }

      if (!restoredViaLastVisible) {
        try {
          const savedY = parseSavedScrollY(sessionStorage.getItem(storageKey))
          if (shouldRestoreScrollY(savedY)) {
            el.scrollTop = savedY as number
          }
        } catch {
          // sessionStorage unavailable (private mode等) — 無視して続行
        }
      }
      restoredKeyRef.current = storageKey
    }

    let ticking = false
    const persist = () => {
      try {
        sessionStorage.setItem(storageKey, String(el.scrollTop))
      } catch {
        // ignore
      }
    }
    const handleScroll = () => {
      if (ticking) return
      ticking = true
      requestAnimationFrame(() => {
        persist()
        ticking = false
      })
    }
    el.addEventListener("scroll", handleScroll, { passive: true })
    window.addEventListener("beforeunload", persist)
    return () => {
      el.removeEventListener("scroll", handleScroll)
      window.removeEventListener("beforeunload", persist)
    }
  }, [loading, images.length, storageKey, lastVisibleStorageKey])

  // Phase 10-23B: IntersectionObserverでcontainerRef内の[data-image-id]要素を
  // 監視し、最も見えているカードのidをsessionStorageへ保存する。auto-fetchは
  // しない(見えている範囲の観測のみ)。images.length/storageKeyが変わるたびに
  // observerを作り直す。
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const cards = el.querySelectorAll<HTMLElement>("[data-image-id]")
    if (cards.length === 0) return

    const observer = new IntersectionObserver(
      (observerEntries) => {
        const visible: VisibleImageEntry[] = []
        for (const entry of observerEntries) {
          if (!entry.isIntersecting) continue
          const id = (entry.target as HTMLElement).dataset.imageId ?? ""
          visible.push({
            id,
            intersectionRatio: entry.intersectionRatio,
            top: entry.boundingClientRect.top,
          })
        }
        const pickedId = pickMostVisibleImageId(visible)
        if (pickedId === null) return
        try {
          sessionStorage.setItem(lastVisibleStorageKey, pickedId)
        } catch {
          // sessionStorage unavailable (private mode等) — 無視
        }
      },
      { root: el, threshold: [0, 0.25, 0.5, 0.75, 1] },
    )

    for (const card of cards) observer.observe(card)
    return () => observer.disconnect()
  }, [images.length, lastVisibleStorageKey])

  // Phase 10-27B: density変更でgrid列数が変わると、生のscrollTop(px)は別の
  // 画像を指すようになり意味をなさない。lastVisibleImageIdはid基準なので
  // density変更後も同じ画像をscrollIntoViewし直せる — 上の復元effect(mount/
  // filter変更時のみ)とは別に、density"変更"時だけ再実行する。
  const prevDensityRef = useRef(density)
  useEffect(() => {
    if (prevDensityRef.current === density) return
    prevDensityRef.current = density
    const el = containerRef.current
    if (!el) return
    try {
      const lastVisibleId = parseSavedLastVisibleImageId(sessionStorage.getItem(lastVisibleStorageKey))
      if (lastVisibleId === null) return
      const cards = el.querySelectorAll<HTMLElement>("[data-image-id]")
      for (const card of cards) {
        if (card.dataset.imageId === lastVisibleId) {
          card.scrollIntoView({ block: "center" })
          break
        }
      }
    } catch {
      // sessionStorage unavailable (private mode等) — 無視
    }
  }, [density, lastVisibleStorageKey])

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-zinc-400">
        読み込み中...
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        <p className="text-sm text-red-500">{error}</p>
        <button
          onClick={onRetry}
          className="rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
        >
          再読み込み
        </button>
      </div>
    )
  }

  if (images.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-zinc-400">
        <svg className="h-12 w-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
          />
        </svg>
        <p className="text-sm">まだ画像がありません</p>
        <button
          onClick={() => router.push("/quick-add")}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
        >
          Quick Add で画像を追加する
        </button>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className={`flex flex-1 flex-col overflow-y-auto p-4 ${
        // Phase 10-25D: mobileの下固定一括操作バーが最後の行/「もっと見る」
        // ボタンに重ならないよう、選択中のみ余分な下paddingを足す。desktop
        // は上部stickyバーのため不要(既存のp-4のまま)。
        bulkSelectedIds.length > 0 ? "pb-24 md:pb-4" : ""
      }`}
    >
      <div className={`grid gap-3 ${getGalleryDensityGridClass(density)}`}>
        {images.map((img) => (
          <ImageCard
            key={img.id}
            image={img}
            selected={selectedId === img.id}
            onClick={() => onSelect(img.id)}
            bulkSelected={bulkSelectedSet.has(img.id)}
            onBulkToggle={onBulkToggle}
            density={density}
            showOrganizationBadges={sort === "needs_review"}
            onFilterChange={onFilterChange}
          />
        ))}
      </div>

      {hasMore && (
        <div className="mt-6 flex justify-center">
          <button
            onClick={onLoadMore}
            disabled={loadingMore}
            className="rounded-md border border-zinc-300 px-5 py-2 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          >
            {loadingMore ? "読み込み中..." : "もっと見る"}
          </button>
        </div>
      )}
    </div>
  )
}
