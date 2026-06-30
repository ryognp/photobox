"use client";

import type { LocalItem } from "../types";

type Props = { selectedItem: LocalItem | null };

function Field({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  const display = typeof value === "object" ? JSON.stringify(value) : String(value);
  return (
    <div className="flex gap-2 py-1">
      <span className="w-32 flex-shrink-0 text-xs text-zinc-400">{label}</span>
      <span className="min-w-0 truncate text-xs text-zinc-700">{display}</span>
    </div>
  );
}

export default function InputPanePlaceholder({ selectedItem }: Props) {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-zinc-100 px-4 py-3">
        <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
          Day 4-A placeholder
        </span>
      </div>

      {!selectedItem ? (
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-400">
          アイテムを選択してください
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className="divide-y divide-zinc-100">
            <Field label="Client ID" value={selectedItem.clientId} />
            <Field label="Server ID" value={selectedItem.serverId} />
            <Field label="Status" value={selectedItem.status} />
            <Field label="uploadStatus" value={selectedItem.serverItem?.uploadStatus} />
            <Field label="promptStatus" value={selectedItem.serverItem?.promptStatus} />
            <Field label="duplicateStatus" value={selectedItem.serverItem?.duplicateStatus} />
            <Field label="commitStatus" value={selectedItem.serverItem?.commitStatus} />
            <Field label="sceneId" value={selectedItem.serverItem?.sceneId} />
            <Field label="rating" value={selectedItem.serverItem?.rating} />
            <Field label="isFavorite" value={selectedItem.serverItem?.isFavorite} />
            <Field label="notes" value={selectedItem.serverItem?.notes} />
            <Field label="tags" value={selectedItem.serverItem?.tags} />
            <Field label="persons" value={selectedItem.serverItem?.persons} />
            {selectedItem.error && (
              <div className="py-1">
                <span className="text-xs text-red-500">{selectedItem.error}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
