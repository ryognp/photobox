"use client"

import { useEffect, useReducer, useRef, useState, Suspense } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
  fetchImages,
  fetchImageDetail,
  bulkAddImageTag,
  bulkAssignImagePerson,
  type GalleryFilters,
  type GalleryImage,
  type ImageDetail,
  type PersonSummary,
  type TagSuggestion,
  type TagSummary,
  type TranslatePromptResult,
} from "@/lib/gallery/imagesClient"
import { removeTagById } from "@/lib/gallery/tagState"
import { addUniqueById } from "@/lib/gallery/personState"
import { toggleBulkSelectedId, clearBulkSelectedIds } from "@/lib/gallery/bulkSelectionState"
import { formatBulkTagSuccessMessage, formatBulkPersonSuccessMessage } from "@/lib/gallery/bulkActionMessage"
import BulkSelectionToolbar from "./_components/BulkSelectionToolbar"
import { applyTranslationUpdate, applyPromptEditToDetailPrompt } from "@/lib/gallery/translationState"
import { normalizeTagIds } from "@/lib/gallery/tagFilters"
import { normalizeSuggestionLabels } from "@/lib/gallery/suggestionFilters"
import { parseGalleryDensity, getGalleryDensityLabel, GALLERY_DENSITY_STORAGE_KEY, type GalleryDensity } from "@/lib/gallery/galleryDensity"
import { parseGallerySort } from "@/lib/gallery/gallerySort"
import SearchBar from "./_components/SearchBar"
import FilterSidebar from "./_components/FilterSidebar"
import ImageGrid from "./_components/ImageGrid"
import DetailPanel from "./_components/DetailPanel"
import MobileDetailDrawer from "./_components/MobileDetailDrawer"
import MobileFilterDrawer from "./_components/MobileFilterDrawer"

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
  // Phase 10-18C: 複数選択(一括操作用)。selectedId(DetailPanel単一選択)とは独立。
  bulkSelectedIds: string[]
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
  | { type: "delete_ok"; id: string }
  | {
      type: "suggestion_resolved"
      suggestionId: string
      action: "approved" | "rejected"
      tag?: { id: string; name: string } | null
    }
  | { type: "analysis_result"; suggestions: TagSuggestion[] }
  | { type: "tag_removed"; tagId: string }
  | { type: "tag_added"; tag: TagSummary }
  | { type: "person_assigned"; person: PersonSummary }
  | { type: "person_removed"; personId: string }
  | { type: "translation_updated"; result: TranslatePromptResult }
  | { type: "prompt_updated"; prompt: ImageDetail["prompt"] }
  | { type: "bulk_toggle_image"; imageId: string }
  | { type: "bulk_select_visible" }
  | { type: "bulk_clear_selection" }
  | { type: "bulk_tag_added"; tag: TagSummary; imageIds: string[] }
  | { type: "bulk_person_assigned"; person: PersonSummary; imageIds: string[] }

function reducer(s: GalleryState, a: GalleryAction): GalleryState {
  switch (a.type) {
    case "fetch_start":
      // Phase 10-18C: filter/sort/search変更(=fetch_start)時は一括選択を解除する
      // (見えない画像が選択に残るUXを避ける、設計レポートの推奨方針)。
      return { ...s, loading: true, error: null, images: [], nextCursor: null, selectedId: null, detail: null, detailLoading: false, detailError: null, bulkSelectedIds: clearBulkSelectedIds() }
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
    case "delete_ok":
      return {
        ...s,
        images: s.images.filter((img) => img.id !== a.id),
        selectedId: s.selectedId === a.id ? null : s.selectedId,
        detail: s.detail?.id === a.id ? null : s.detail,
        detailLoading: false,
        detailError: null,
        // 削除された画像が一括選択に残らないようにする
        bulkSelectedIds: s.bulkSelectedIds.filter((id) => id !== a.id),
      }
    case "suggestion_resolved": {
      if (!s.detail) return s
      const tagSuggestions = s.detail.tagSuggestions.filter((sug) => sug.id !== a.suggestionId)
      let tags = s.detail.tags
      if (a.action === "approved" && a.tag && !tags.some((t) => t.id === a.tag!.id)) {
        tags = [...tags, a.tag]
      }
      return { ...s, detail: { ...s.detail, tags, tagSuggestions } }
    }
    case "analysis_result": {
      if (!s.detail) return s
      return { ...s, detail: { ...s.detail, tagSuggestions: a.suggestions } }
    }
    case "tag_removed": {
      if (!s.detail) return s
      return { ...s, detail: { ...s.detail, tags: removeTagById(s.detail.tags, a.tagId) } }
    }
    case "tag_added": {
      if (!s.detail) return s
      return { ...s, detail: { ...s.detail, tags: addUniqueById(s.detail.tags, a.tag) } }
    }
    case "person_assigned": {
      if (!s.detail) return s
      return { ...s, detail: { ...s.detail, persons: addUniqueById(s.detail.persons, a.person) } }
    }
    case "person_removed": {
      if (!s.detail) return s
      return { ...s, detail: { ...s.detail, persons: removeTagById(s.detail.persons, a.personId) } }
    }
    case "translation_updated": {
      if (!s.detail) return s
      return { ...s, detail: applyTranslationUpdate(s.detail, a.result) }
    }
    case "prompt_updated": {
      // Keep the shared detail's currentBody + translation in sync with a prompt
      // edit, so a subsequent translate uses the fresh body (not a stale one).
      if (!s.detail || !s.detail.prompt || !a.prompt) return s
      return { ...s, detail: { ...s.detail, prompt: applyPromptEditToDetailPrompt(s.detail.prompt, a.prompt) } }
    }
    case "bulk_toggle_image":
      return { ...s, bulkSelectedIds: toggleBulkSelectedId(s.bulkSelectedIds, a.imageId) }
    case "bulk_select_visible":
      // 現在表示中(=もっと見るで読み込み済み)の全画像を選択。
      return { ...s, bulkSelectedIds: s.images.map((img) => img.id) }
    case "bulk_clear_selection":
      return { ...s, bulkSelectedIds: clearBulkSelectedIds() }
    case "bulk_tag_added": {
      // Phase 10-24B: state.imagesの対象画像にもtagをローカルmergeし、Grid
      // カードのタグ表示を即時反映する。開いているdetailがbulk対象に含まれる
      // 場合はdetail.tagsも同様に更新。bulkSelectedIdsは成功後も維持する。
      const images = s.images.map((img) =>
        a.imageIds.includes(img.id) ? { ...img, tags: addUniqueById(img.tags, a.tag) } : img,
      )
      const detail =
        s.detail && a.imageIds.includes(s.detail.id)
          ? { ...s.detail, tags: addUniqueById(s.detail.tags, a.tag) }
          : s.detail
      return { ...s, images, detail }
    }
    case "bulk_person_assigned": {
      if (!s.detail || !a.imageIds.includes(s.detail.id)) return s
      return { ...s, detail: { ...s.detail, persons: addUniqueById(s.detail.persons, a.person) } }
    }
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
  bulkSelectedIds: [],
}

// ---- URL helpers ----

function filtersToSearchParams(filters: GalleryFilters): URLSearchParams {
  const sp = new URLSearchParams()
  if (filters.personId) sp.set("personId", filters.personId)
  if (filters.sceneId) sp.set("sceneId", filters.sceneId)
  if (filters.tagIds.length > 0) sp.set("tagIds", filters.tagIds.join(","))
  if (filters.suggestionLabels.length > 0) sp.set("suggestionLabels", filters.suggestionLabels.join(","))
  if (filters.favorite) sp.set("favorite", "true")
  if (filters.q) sp.set("q", filters.q)
  if (filters.sort !== "newest") sp.set("sort", filters.sort)
  // Phase 10-28B: organization quick filters.
  if (filters.untagged) sp.set("untagged", "true")
  if (filters.unpersoned) sp.set("unpersoned", "true")
  if (filters.hasSuggestions) sp.set("hasSuggestions", "true")
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
    // Phase 10-7B: legacy ?tagId=xxx and new ?tagIds=a,b both read here.
    tagIds: normalizeTagIds({ tagId: searchParams.get("tagId"), tagIdsParam: searchParams.get("tagIds") }),
    // Phase 10-9B: AI-candidate tag filter labels.
    suggestionLabels: normalizeSuggestionLabels(searchParams.get("suggestionLabels")),
    favorite: searchParams.get("favorite") === "true" ? true : null,
    q: searchParams.get("q") ?? "",
    sort: parseGallerySort(searchParams.get("sort")),
    // Phase 10-28B: organization quick filters.
    untagged: searchParams.get("untagged") === "true",
    unpersoned: searchParams.get("unpersoned") === "true",
    hasSuggestions: searchParams.get("hasSuggestions") === "true",
  }

  const [state, dispatch] = useReducer(reducer, {
    ...INITIAL,
    debouncedQ: filters.q,
  })
  const qTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fetchSeq = useRef(0)

  // Phase 10-8B: mobile filter drawer is exclusive with the mobile detail
  // drawer — ephemeral UI state, so it lives here as local state (not in the
  // reducer, which only tracks fetched data).
  const [filterDrawerOpen, setFilterDrawerOpen] = useState(false)

  // Phase 10-27B: Gallery display density (comfortable/standard/compact).
  // Pure display preference, not fetched data — kept out of the reducer.
  // Read via a lazy useState initializer (not a mount effect + setState,
  // which react-hooks/set-state-in-effect flags) — safe here because the
  // grid itself never appears in server-rendered HTML anyway (state.loading
  // starts true, so ImageGrid renders "読み込み中..." until the client-side
  // fetch effect resolves), so there is no SSR/hydration mismatch risk.
  const [density, setDensity] = useState<GalleryDensity>(() => {
    if (typeof window === "undefined") return "standard"
    try {
      return parseGalleryDensity(window.localStorage.getItem(GALLERY_DENSITY_STORAGE_KEY))
    } catch {
      return "standard"
    }
  })

  useEffect(() => {
    try {
      window.localStorage.setItem(GALLERY_DENSITY_STORAGE_KEY, density)
    } catch {
      // ignore — best-effort persistence only
    }
  }, [density])

  // Debounce q from URL → debouncedQ in state
  useEffect(() => {
    if (qTimer.current) clearTimeout(qTimer.current)
    qTimer.current = setTimeout(() => dispatch({ type: "set_debounced_q", q: filters.q }), 300)
  }, [filters.q])

  // filters.tagIds / suggestionLabels are new arrays each render (normalize*) —
  // join to stable primitives so the effect below doesn't re-fire every render.
  const tagIdsKey = filters.tagIds.join(",")
  const suggestionLabelsKey = filters.suggestionLabels.join(",")

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
    tagIdsKey,
    suggestionLabelsKey,
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

  // Phase 10-18D: bulk tag/person action — 既存bulk API(Phase 10-18B)を呼び、
  // 開いているdetailがbulk対象に含まれる場合のみreducerでtags/personsを更新
  // する。bulkSelectedIdsは呼び出し元(BulkSelectionToolbar)が成功後も維持する。
  const handleBulkAddTag = async (name: string): Promise<string> => {
    const imageIds = state.bulkSelectedIds
    const result = await bulkAddImageTag(imageIds, name)
    dispatch({ type: "bulk_tag_added", tag: result.tag, imageIds })
    return formatBulkTagSuccessMessage(result.tag.name, result)
  }

  const handleBulkAssignPerson = async (name: string): Promise<string> => {
    const imageIds = state.bulkSelectedIds
    const result = await bulkAssignImagePerson(imageIds, name)
    dispatch({ type: "bulk_person_assigned", person: result.person, imageIds })
    return formatBulkPersonSuccessMessage(result.person.name, result)
  }

  // Phase 10-26B: DetailPanel/MobileDetailDrawerから現在表示中の画像を一括
  // 選択に追加/解除する。新しいactionは作らず、既存のbulk_toggle_imageを
  // そのまま再利用する(ImageGridのonBulkToggleと同じdispatch)。
  const isDetailBulkSelected = state.selectedId !== null && state.bulkSelectedIds.includes(state.selectedId)
  const handleToggleBulkSelected = () => {
    if (state.selectedId) dispatch({ type: "bulk_toggle_image", imageId: state.selectedId })
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-50">
      {/* Header (Phase 10-8D: nav buttons hidden below md so the mobile
          "フィルター" trigger always fits — it was being pushed off-screen
          by Quick Add/Masters/Import + fixed-width SearchBar on narrow
          viewports).
          Phase 10-25D-pre: that hid ALL image-add entry points on mobile
          (Quick Add/Masters/Import are all md:inline-only) — added a
          mobile-only "＋ 追加" button (→ /quick-add, matching the desktop
          "Quick Add" link) so mobile users have a way in. Header switches to
          a 2-row layout on mobile (row 1: title + 追加 + フィルター, row 2:
          full-width search) and stays a single row on desktop (md:flex-row),
          since 追加/フィルター are both md:hidden there anyway. */}
      <header className="flex flex-col gap-2 border-b border-zinc-200 bg-white px-4 py-3 sm:gap-3 sm:px-5 md:flex-row md:items-center md:gap-4">
        <div className="flex items-center gap-3 sm:gap-4">
          <button
            onClick={() => router.push("/quick-add")}
            className="hidden text-sm text-zinc-500 hover:text-zinc-900 md:inline"
          >
            Quick Add
          </button>
          <button
            onClick={() => router.push("/masters")}
            className="hidden text-sm text-zinc-500 hover:text-zinc-900 md:inline"
          >
            Masters
          </button>
          <button
            onClick={() => router.push("/import")}
            className="hidden text-sm text-zinc-500 hover:text-zinc-900 md:inline"
          >
            Import
          </button>
          <h1 className="shrink-0 text-base font-semibold text-zinc-900">Gallery</h1>
          <span className="hidden shrink-0 text-sm text-zinc-400 sm:inline">
            {state.loading ? "…" : `${state.images.length} 枚`}
          </span>
          {/* Phase 10-27B: PC専用の表示密度切替(モバイルはFilter drawer内)。 */}
          <div className="hidden shrink-0 items-center gap-1 md:flex">
            {(["comfortable", "standard", "compact"] as const).map((d) => (
              <button
                key={d}
                onClick={() => setDensity(d)}
                className={`min-h-10 rounded-md border px-2.5 py-1.5 text-xs ${
                  density === d
                    ? "border-amber-500 bg-amber-50 font-medium text-amber-700"
                    : "border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-50"
                }`}
              >
                {getGalleryDensityLabel(d)}
              </button>
            ))}
          </div>
          <button
            onClick={() => router.push("/quick-add")}
            className="ml-auto min-h-10 shrink-0 rounded-md border border-blue-300 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700 hover:bg-blue-100 md:hidden"
          >
            ＋ 追加
          </button>
          {/* md以上はFilterSidebarが常時表示のため不要 */}
          <button
            onClick={() => {
              dispatch({ type: "select", id: null })
              setFilterDrawerOpen(true)
            }}
            className="min-h-10 shrink-0 rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50 md:hidden"
            aria-label="フィルターを開く"
          >
            フィルター
          </button>
        </div>
        <div className="min-w-0 flex-1 sm:max-w-72 md:ml-auto">
          <SearchBar value={filters.q} onChange={handleQChange} />
        </div>
      </header>

      {/* Phase 10-18C/D: 一括選択toolbar（選択0件時は自身で非表示）+
          タグ/人物一括追加action panel。 */}
      <BulkSelectionToolbar
        selectedCount={state.bulkSelectedIds.length}
        visibleCount={state.images.length}
        onSelectVisible={() => dispatch({ type: "bulk_select_visible" })}
        onClear={() => dispatch({ type: "bulk_clear_selection" })}
        onBulkAddTag={handleBulkAddTag}
        onBulkAssignPerson={handleBulkAssignPerson}
      />

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        <FilterSidebar
          filters={filters}
          onChange={handleFilterChange}
          density={density}
          onDensityChange={setDensity}
        />

        <ImageGrid
          images={state.images}
          selectedId={state.selectedId}
          onSelect={(id) => {
            setFilterDrawerOpen(false)
            dispatch({ type: "select", id })
          }}
          bulkSelectedIds={state.bulkSelectedIds}
          onBulkToggle={(imageId) => dispatch({ type: "bulk_toggle_image", imageId })}
          density={density}
          sort={filters.sort}
          onFilterChange={handleFilterChange}
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
            onDeleted={(id) => dispatch({ type: "delete_ok", id })}
            onSuggestionResolved={(payload) => dispatch({ type: "suggestion_resolved", ...payload })}
            onAnalyzed={(suggestions) => dispatch({ type: "analysis_result", suggestions })}
            onTagRemoved={(tagId) => dispatch({ type: "tag_removed", tagId })}
            onTagAdded={(tag) => dispatch({ type: "tag_added", tag })}
            onPersonAssigned={(person) => dispatch({ type: "person_assigned", person })}
            onPersonRemoved={(personId) => dispatch({ type: "person_removed", personId })}
            onTranslated={(result) => dispatch({ type: "translation_updated", result })}
            onPromptSaved={(prompt) => dispatch({ type: "prompt_updated", prompt })}
            isBulkSelected={isDetailBulkSelected}
            onToggleBulkSelected={handleToggleBulkSelected}
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
        onDeleted={(id) => dispatch({ type: "delete_ok", id })}
        onSuggestionResolved={(payload) => dispatch({ type: "suggestion_resolved", ...payload })}
        onAnalyzed={(suggestions) => dispatch({ type: "analysis_result", suggestions })}
        onTagRemoved={(tagId) => dispatch({ type: "tag_removed", tagId })}
        onTagAdded={(tag) => dispatch({ type: "tag_added", tag })}
        onPersonAssigned={(person) => dispatch({ type: "person_assigned", person })}
        onPersonRemoved={(personId) => dispatch({ type: "person_removed", personId })}
        onTranslated={(result) => dispatch({ type: "translation_updated", result })}
        onPromptSaved={(prompt) => dispatch({ type: "prompt_updated", prompt })}
        isBulkSelected={isDetailBulkSelected}
        onToggleBulkSelected={handleToggleBulkSelected}
        prefetchedDetail={state.detail}
        prefetchedLoading={state.detailLoading}
        prefetchedError={state.detailError}
      />

      {/* Mobile filter drawer (md未満でのみ表示、detail drawerと排他) */}
      <MobileFilterDrawer
        open={filterDrawerOpen}
        filters={filters}
        onChange={handleFilterChange}
        onClose={() => setFilterDrawerOpen(false)}
        density={density}
        onDensityChange={setDensity}
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
