"use client"

import { useRouter } from "next/navigation"
import type { GalleryImage } from "@/lib/gallery/imagesClient"
import ImageCard from "./ImageCard"

interface ImageGridProps {
  images: GalleryImage[]
  selectedId: string | null
  onSelect: (id: string) => void
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  onLoadMore: () => void
  onRetry: () => void
  error: string | null
}

export default function ImageGrid({
  images,
  selectedId,
  onSelect,
  loading,
  loadingMore,
  hasMore,
  onLoadMore,
  onRetry,
  error,
}: ImageGridProps) {
  const router = useRouter()

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
    <div className="flex flex-1 flex-col overflow-y-auto p-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {images.map((img) => (
          <ImageCard
            key={img.id}
            image={img}
            selected={selectedId === img.id}
            onClick={() => onSelect(img.id)}
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
