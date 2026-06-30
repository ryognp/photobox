"use client";

import type { LocalItem } from "../types";
import UploadItemCard from "./UploadItemCard";

type Props = {
  items: LocalItem[];
  selectedClientId: string | null;
  onSelect: (clientId: string) => void;
  // NEW: multi-select for Mode B
  checkedClientIds: string[];
  onToggleCheck: (clientId: string) => void;
};

export default function ItemStrip({
  items,
  selectedClientId,
  onSelect,
  checkedClientIds,
  onToggleCheck,
}: Props) {
  if (items.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-zinc-400 p-4 text-center">
        画像を追加してください
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto divide-y divide-zinc-100">
      {checkedClientIds.length > 0 && (
        <div className="px-4 py-2 text-xs text-zinc-500 bg-zinc-50">
          {checkedClientIds.length} 枚選択中
        </div>
      )}
      {items.map((item) => (
        <UploadItemCard
          key={item.clientId}
          item={item}
          isSelected={item.clientId === selectedClientId}
          onClick={() => onSelect(item.clientId)}
          isChecked={checkedClientIds.includes(item.clientId)}
          onToggleCheck={() => onToggleCheck(item.clientId)}
        />
      ))}
    </div>
  );
}
