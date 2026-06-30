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
      {/* Thumbnail */}
      <div className="aspect-square w-full overflow-hidden bg-zinc-200">
        {image.thumbnailUrl && !imgError ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image.thumbnailUrl}
            alt={image.originalName}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition-transform group-hover:scale-105"
            onError={markError}
          />
        ) : (
          <ImagePlaceholder />
        )}
      </div>

      {/* Favorite badge */}
      {image.isFavorite && (
        <span className="absolute right-1.5 top-1.5 text-yellow-400 drop-shadow">★</span>
      )}

      {/* Prompt version badge */}
      {image.promptVersionCount > 0 && (
        <span className="absolute left-1.5 top-1.5 rounded bg-indigo-500/80 px-1 py-0.5 text-[10px] font-medium leading-none text-white">
          履歴 {image.promptVersionCount}
        </span>
      )}

      {/* Info */}
      <div className="p-2">
        <p className="truncate text-xs font-medium text-zinc-800">{image.originalName}</p>
        {image.scene && (
          <p className="mt-0.5 truncate text-xs text-zinc-500">{image.scene.name}</p>
        )}
        {image.promptSnippet && (
          <p className="mt-0.5 truncate text-xs text-zinc-400">{image.promptSnippet}</p>
        )}
        {image.tags.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
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
        )}
      </div>
    </button>
  )
}
