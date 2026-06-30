"use client"

import { useEffect, useReducer, useRef, Suspense } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
  fetchImages,
  fetchImageDetail,
  type GalleryFilters,
  type GalleryImage,
  type ImageDetail,
} from "@/lib/gallery/imagesClient"
import SearchBar from "./_components/SearchBar"
import FilterSidebar from "./_components/FilterSidebar"
import ImageGrid from "./_components/ImageGrid"
import DetailPanel from "./_components/DetailPanel"
import MobileDetailDrawer from "./_components/MobileDetailDrawer"

// ---- State (images/loading only — filters live in URL) ----

type GalleryState = {
  images: GalleryImage[]
  loading: boolean
  loadingMore: boolean
  error: string | null
  nextCursor: string | null
  debouncedQ: string
  selectedId: string | null
  fetchKey: number
  // 詳細パネル用 (Desktop/Mobile 共有、二重fetch防止)
  detail: ImageDetail | null
  detailLoading: boolean
  detailError: string | null
}

type GalleryAction =
  | { type: "fetch_start" }
  | { type: "fetch_ok"; images: GalleryImage[]; nextCursor: string | null }
  | { type: "fetch_error"; message: string }
  | { type: "more_start" }
  | { type: "more_ok"; images: GalleryImage[]; nextCursor: string | null }
  | { type: "set_debounced_q"; q: string }
  | { type: "select"; id: string | null }
  | { type: "retry" }
  | { type: "detail_start" }
  | { type: "detail_ok"; detail: ImageDetail }
  | { type: "detail_error"; message: string }

function reducer(s: GalleryState, a: GalleryAction): GalleryState {
  switch (a.type) {
    case "fetch_start":
      return { ...s, loading: true, error: null, images: [], nextCursor: null, selectedId: null, detail: null, detailLoading: false, detailError: null }
    case "fetch_ok":
      return { ...s, loading: false, images: a.images, nextCursor: a.nextCursor }
    case "fetch_error":
      return { ...s, loading: false, error: a.message }
    case "more_start":
      return { ...s, loadingMore: true }
    case "more_ok":
      return { ...s, loadingMore: false, images: [...s.images, ...a.images], nextCursor: a.nextCursor }
    case "set_debounced_q":
      return { ...s, debouncedQ: a.q }
    case "select":
      return { ...s, selectedId: a.id, detail: null, detailLoading: a.id !== null, detailError: null }
    case "retry":
      return { ...s, fetchKey: s.fetchKey + 1 }
    case "detail_start":
      return { ...s, detailLoading: true, detailError: null }
    case "detail_ok":
      return { ...s, detailLoading: false, detail: a.detail }
    case "detail_error":
      return { ...s, detailLoading: false, detailError: a.message }
  }
}

const INITIAL: GalleryState = {
  images: [],
  loading: true,
  loadingMore: false,
  error: null,
  nextCursor: null,
  debouncedQ: "",
  selectedId: null,
  fetchKey: 0,
  detail: null,
  detailLoading: false,
  detailError: null,
}

// ---- URL helpers ----

function filtersToSearchParams(filters: GalleryFilters): URLSearchParams {
  const sp = new URLSearchParams()
  if (filters.personId) sp.set("personId", filters.personId)
  if (filters.sceneId) sp.set("sceneId", filters.sceneId)
  if (filters.tagId) sp.set("tagId", filters.tagId)
  if (filters.favorite) sp.set("favorite", "true")
  if (filters.q) sp.set("q", filters.q)
  if (filters.sort !== "newest") sp.set("sort", filters.sort)
  return sp
}

// ---- Inner client (needs useSearchParams) ----

function GalleryInner() {
  const router = useRouter()
  const searchParams = useSearchParams()

  // Derive filters from URL (source of truth)
  const filters: GalleryFilters = {
    personId: searchParams.get("personId"),
    sceneId: searchParams.get("sceneId"),
    tagId: searchParams.get("tagId"),
    favorite: searchParams.get("favorite") === "true" ? true : null,
    q: searchParams.get("q") ?? "",
    sort: (searchParams.get("sort") as "newest" | "oldest") || "newest",
  }

  const [state, dispatch] = useReducer(reducer, {
    ...INITIAL,
    debouncedQ: filters.q,
  })
  const qTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fetchSeq = useRef(0)

  // Debounce q from URL → debouncedQ in state
  useEffect(() => {
    if (qTimer.current) clearTimeout(qTimer.current)
    qTimer.current = setTimeout(() => dispatch({ type: "set_debounced_q", q: filters.q }), 300)
  }, [filters.q])

  // Fetch when URL-derived filters change (includes back/forward)
  useEffect(() => {
    const seq = ++fetchSeq.current
    const run = async () => {
      dispatch({ type: "fetch_start" })
      try {
        const page = await fetchImages({ ...filters, q: state.debouncedQ }, null)
        if (fetchSeq.current === seq) {
          dispatch({ type: "fetch_ok", images: page.images, nextCursor: page.nextCursor })
        }
      } catch (e: unknown) {
        if (fetchSeq.current === seq) {
          dispatch({ type: "fetch_error", message: (e as Error).message ?? "エラーが発生しました" })
        }
      }
    }
    void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.debouncedQ,
    filters.sceneId,
    filters.tagId,
    filters.personId,
    filters.favorite,
    filters.sort,
    state.fetchKey,
  ])

  // Fetch detail when selectedId changes (shared by Desktop and Mobile)
  useEffect(() => {
    if (!state.selectedId) return
    const id = state.selectedId
    const controller = new AbortController()
    dispatch({ type: "detail_start" })
    fetchImageDetail(id)
      .then((detail) => {
        if (!controller.signal.aborted) dispatch({ type: "detail_ok", detail })
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted)
          dispatch({ type: "detail_error", message: (e as Error).message ?? "エラーが発生しました" })
      })
    return () => controller.abort()
  }, [state.selectedId])

  // Update URL when filters change (called from UI)
  const handleFilterChange = (patch: Partial<GalleryFilters>) => {
    const next: GalleryFilters = { ...filters, ...patch }
    const sp = filtersToSearchParams(next)
    const query = sp.toString()
    router.replace(query ? `/gallery?${query}` : "/gallery")
  }

  // q change: update URL immediately, debounce fires actual fetch
  const handleQChange = (q: string) => {
    const next: GalleryFilters = { ...filters, q }
    const sp = filtersToSearchParams(next)
    const query = sp.toString()
    router.replace(query ? `/gallery?${query}` : "/gallery")
  }

  const handleLoadMore = async () => {
    if (!state.nextCursor || state.loadingMore) return
    dispatch({ type: "more_start" })
    try {
      const page = await fetchImages({ ...filters, q: state.debouncedQ }, state.nextCursor)
      dispatch({ type: "more_ok", images: page.images, nextCursor: page.nextCursor })
    } catch {
      dispatch({ type: "more_ok", images: [], nextCursor: null })
    }
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-50">
      {/* Header */}
      <header className="flex items-center gap-4 border-b border-zinc-200 bg-white px-5 py-3">
        <button
          onClick={() => router.push("/quick-add")}
          className="text-sm text-zinc-500 hover:text-zinc-900"
        >
          Quick Add
        </button>
        <button
          onClick={() => router.push("/masters")}
          className="text-sm text-zinc-500 hover:text-zinc-900"
        >
          Masters
        </button>
        <button
          onClick={() => router.push("/import")}
          className="text-sm text-zinc-500 hover:text-zinc-900"
        >
          Import
        </button>
        <h1 className="text-base font-semibold text-zinc-900">Gallery</h1>
        <span className="text-sm text-zinc-400">
          {state.loading ? "..." : `${state.images.length} 枚`}
        </span>
        <div className="ml-auto w-40 sm:w-72">
          <SearchBar value={filters.q} onChange={handleQChange} />
        </div>
      </header>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        <FilterSidebar
          filters={filters}
          onChange={handleFilterChange}
        />

        <ImageGrid
          images={state.images}
          selectedId={state.selectedId}
          onSelect={(id) => dispatch({ type: "select", id })}
          loading={state.loading}
          loadingMore={state.loadingMore}
          hasMore={state.nextCursor !== null}
          onLoadMore={() => void handleLoadMore()}
          onRetry={() => dispatch({ type: "retry" })}
          error={state.error}
        />

        <div className="hidden md:contents">
          <DetailPanel
            imageId={state.selectedId}
            onClose={() => dispatch({ type: "select", id: null })}
            prefetchedDetail={state.detail}
            prefetchedLoading={state.detailLoading}
            prefetchedError={state.detailError}
          />
        </div>
      </div>

      {/* Mobile drawer (md未満でのみ表示) */}
      <MobileDetailDrawer
        imageId={state.selectedId}
        onClose={() => dispatch({ type: "select", id: null })}
        prefetchedDetail={state.detail}
        prefetchedLoading={state.detailLoading}
        prefetchedError={state.detailError}
      />
    </div>
  )
}

// ---- Public export with Suspense boundary (useSearchParams requires it) ----

export default function GalleryClient() {
  return (
    <Suspense fallback={null}>
      <GalleryInner />
    </Suspense>
  )
}
