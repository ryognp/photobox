"use client"

import { useReducer } from "react"
import type { GalleryImage } from "@/lib/gallery/imagesClient"

interface ImageCardProps {
  image: GalleryImage
  selected: boolean
  onClick: () => void
  /** Phase 10-18C: bulk multi-select (independent of `selected`, which is the
   *  single DetailPanel selection). */
  bulkSelected: boolean
  onBulkToggle: (imageId: string) => void
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

export default function ImageCard({ image, selected, onClick, bulkSelected, onBulkToggle }: ImageCardProps) {
  const [imgError, markError] = useReducer(() => true, false)

  // Phase 10-18C: 外側は button ではなく role="button" の div。checkbox 用の
  // button を内側に持つため（button の入れ子は不正HTML）。クリック/Enter/Space
  // で従来通り DetailPanel を開く。bulkSelected(一括選択) と selected(DetailPanel
  // 単一選択) は独立し、枠の見た目も別 — bulk は amber リング、selected は blue。
  return (
    <div
      role="button"
      tabIndex={0}
      data-image-id={image.id}
      onClick={onClick}
      onKeyDown={(e) => {
        // イベント発生元が親div自身でない場合(例: 内側のcheckbox buttonに
        // フォーカスしてEnter/Space)は何もしない。keydownはonClickのような
        // stopPropagationを内側で行っておらずbubbleするため、ここで発生元を
        // 見て親div由来のキー操作だけをDetailPanel開閉に使う。
        if (e.target !== e.currentTarget) return
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onClick()
        }
      }}
      className={`group relative cursor-pointer overflow-hidden rounded-lg border bg-zinc-100 text-left transition-shadow ${
        bulkSelected
          ? "border-amber-500 ring-2 ring-amber-500"
          : selected
            ? "border-blue-500 ring-2 ring-blue-500"
            : "border-zinc-200 hover:border-zinc-300 hover:shadow-md"
      }`}
    >
      {/* Bulk-select checkbox (左上). stopPropagation で DetailPanel を開かない。
          Phase 10-25B: buttonのタップ領域を44px近くまで拡大(スマホでの誤操作対策)。
          見た目のチップは従来サイズ(h-6 w-6)のまま、button自体はh-10 w-10の
          透明な当たり判定として配置する。 */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onBulkToggle(image.id)
        }}
        aria-label={bulkSelected ? "選択を解除" : "選択"}
        aria-pressed={bulkSelected}
        className="absolute left-1 top-1 z-10 flex h-10 w-10 items-center justify-center"
      >
        <span
          className={`flex h-6 w-6 items-center justify-center rounded-md border text-xs transition-colors ${
            bulkSelected
              ? "border-amber-500 bg-amber-500 text-white"
              : "border-zinc-300 bg-white/80 text-transparent hover:border-amber-400 hover:text-amber-400"
          }`}
        >
          ✓
        </span>
      </button>

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
    </div>
  )
}
