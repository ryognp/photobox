"use client";

import type { LocalItem } from "../types";

type Props = {
  selectedItem: LocalItem | null;
  items: LocalItem[];
  onNavigate: (direction: "prev" | "next") => void;
  // Phase 10-41-A: 保存中は前へ/次へを無効化する
  disabled?: boolean;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getPreviewSrc(item: LocalItem): string | null {
  return (
    item.signedUrls?.preview?.signedUrl ??
    item.signedUrls?.thumbnail?.signedUrl ??
    item.signedUrls?.original?.signedUrl ??
    item.previewObjectUrl ??
    null
  );
}

export default function PreviewPane({ selectedItem, items, onNavigate, disabled = false }: Props) {
  if (!selectedItem) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-zinc-400">
        画像を選択してください
      </div>
    );
  }

  const currentIndex = items.findIndex((i) => i.clientId === selectedItem.clientId);
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < items.length - 1;

  const previewSrc = getPreviewSrc(selectedItem);
  const name = selectedItem.file?.name ?? (selectedItem.serverItem?.originalName as string | undefined) ?? "unknown";
  const size = selectedItem.file?.size;
  const hash = selectedItem.serverItem?.clientFileHash as string | undefined;
  const w = selectedItem.serverItem?.widthPx as number | undefined;
  const h = selectedItem.serverItem?.heightPx as number | undefined;

  const isProcessing = selectedItem.status !== "done" && selectedItem.status !== "error";

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Image area */}
      <div className="flex flex-1 items-center justify-center overflow-hidden bg-zinc-100 p-4">
        {isProcessing ? (
          <div className="flex flex-col items-center gap-2 text-zinc-400">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-300 border-t-blue-500" />
            <span className="text-sm">{name}</span>
            <span className="text-xs capitalize">{selectedItem.status}…</span>
          </div>
        ) : previewSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewSrc}
            alt={name}
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <div className="flex flex-col items-center gap-2 text-zinc-400">
            <div className="h-32 w-32 rounded-lg bg-zinc-200" />
            <span className="text-sm">プレビューなし</span>
          </div>
        )}
      </div>

      {/* Info bar */}
      <div className="border-t border-zinc-200 bg-white px-4 py-2">
        <p className="truncate text-sm font-medium text-zinc-800">{name}</p>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
          {size !== undefined && <span>{formatBytes(size)}</span>}
          {w !== undefined && h !== undefined && <span>{w} × {h}</span>}
          {hash && <span className="font-mono">{hash.slice(0, 12)}</span>}
        </div>
      </div>

      {/* Navigation */}
      <div className="flex items-center justify-between border-t border-zinc-200 bg-white px-4 py-2">
        <button
          onClick={() => onNavigate("prev")}
          disabled={!hasPrev || disabled}
          className="rounded px-3 py-1 text-sm text-zinc-600 hover:bg-zinc-100 disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1"
        >
          ← 前へ
        </button>
        <span className="text-xs text-zinc-400">
          {currentIndex + 1} / {items.length}
        </span>
        <button
          onClick={() => onNavigate("next")}
          disabled={!hasNext || disabled}
          className="rounded px-3 py-1 text-sm text-zinc-600 hover:bg-zinc-100 disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1"
        >
          次へ →
        </button>
      </div>
    </div>
  );
}
