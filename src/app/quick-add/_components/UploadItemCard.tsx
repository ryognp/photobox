"use client";

import type { LocalItem } from "../types";

type Props = {
  item: LocalItem;
  isSelected: boolean;
  onClick: () => void;
  // NEW
  isChecked: boolean;
  onToggleCheck: (e: React.ChangeEvent<HTMLInputElement>) => void;
};

function StatusBadge({ item }: { item: LocalItem }) {
  const { status, serverItem, error } = item;

  if (status === "queued") return <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-500">待機中</span>;
  if (status === "hashing" || status === "compressing") return <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-600">処理中</span>;
  if (status === "uploading") return <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-600">転送中</span>;
  if (status === "error" || error) return <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-600">エラー</span>;

  if (status === "done" && serverItem) {
    const uploadStatus = serverItem.uploadStatus as string | undefined;
    const duplicateStatus = serverItem.duplicateStatus as string | undefined;
    const promptStatus = serverItem.promptStatus as string | undefined;

    if (uploadStatus === "ERROR") return <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-600">エラー</span>;
    if (duplicateStatus === "DUPLICATE") return <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-600">重複</span>;
    if (promptStatus === "FILLED") return <span className="rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-600">入力済</span>;
    if (promptStatus === "DRAFT") return <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-600">入力中</span>;
    return <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-500">未入力</span>;
  }

  return null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function UploadItemCard({ item, isSelected, onClick, isChecked, onToggleCheck }: Props) {
  const name = item.file?.name ?? (item.serverItem?.originalName as string | undefined) ?? "unknown";
  const size = item.file?.size;

  const thumbSrc =
    item.previewObjectUrl ??
    (item.signedUrls?.thumbnail?.signedUrl ?? null) ??
    null;

  return (
    <button
      onClick={onClick}
      className={[
        "flex w-full items-center gap-2 p-2 text-left hover:bg-zinc-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2",
        isSelected ? "ring-2 ring-inset ring-blue-500 bg-blue-50" : "",
      ].join(" ")}
    >
      <input
        type="checkbox"
        checked={isChecked}
        onChange={onToggleCheck}
        onClick={(e) => e.stopPropagation()}
        className="flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1"
      />
      <div className="h-10 w-10 flex-shrink-0 overflow-hidden rounded bg-zinc-100">
        {thumbSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumbSrc} alt={name} className="h-full w-full object-cover" />
        ) : (
          <div className="h-full w-full bg-zinc-200" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-zinc-800">{name}</p>
        {size !== undefined && (
          <p className="text-xs text-zinc-400">{formatBytes(size)}</p>
        )}
        <div className="mt-0.5">
          <StatusBadge item={item} />
        </div>
        {item.error && (
          <p className="truncate text-xs text-red-500">{item.error}</p>
        )}
      </div>
    </button>
  );
}
