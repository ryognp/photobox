"use client"

import { useReducer } from "react"
import type { GalleryImage } from "@/lib/gallery/imagesClient"

interface ImageCardProps {
  image: GalleryImage
  selected: boolean
  onClick: () => void
}

function ImagePlaceholder() {
  return (
    <div className="flex h-full w-full items-center justify-center text-zinc-400">
      <svg className="h-8 w-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
        />
      </svg>
    </div>
  )
}

export default function ImageCard({ image, selected, onClick }: ImageCardProps) {
  const [imgError, markError] = useReducer(() => true, false)

  return (
    <button
      onClick={onClick}
      className={`group relative overflow-hidden rounded-lg border bg-zinc-100 text-left transition-shadow ${
        selected
          ? "border-blue-500 ring-2 ring-blue-500"
          : "border-zinc-200 hover:border-zinc-300 hover:shadow-md"
      }`}
    >
      {/* Thumbnail (Phase 10-9A: object-position 上寄せで顔/上半身が切れにくく) */}
      <div className="aspect-square w-full overflow-hidden bg-zinc-200">
        {image.thumbnailUrl && !imgError ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image.thumbnailUrl}
            alt={image.originalName}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition-transform group-hover:scale-105"
            style={{ objectPosition: "center 25%" }}
            onError={markError}
          />
        ) : (
          <ImagePlaceholder />
        )}
      </div>

      {/* Phase 10-9A: カードはサムネイル + 承認済みタグのみ。originalName /
          scene / promptSnippet / Favorite badge / 履歴 badge は非表示。
          タグ0件なら情報部そのものを描画しない（文言も出さない）。 */}
      {image.tags.length > 0 && (
        <div className="p-2">
          <div className="flex flex-wrap gap-1">
            {image.tags.slice(0, 3).map((t) => (
              <span
                key={t.id}
                className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600"
              >
                {t.name}
              </span>
            ))}
            {image.tags.length > 3 && (
              <span className="text-xs text-zinc-400">+{image.tags.length - 3}</span>
            )}
          </div>
        </div>
      )}
    </button>
  )
}
