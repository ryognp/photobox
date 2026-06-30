"use client"

import CommitItemCard from "./CommitItemCard";

type Props = {
  items: Record<string, unknown>[];
  activeTab: "all" | "filled" | "missing" | "duplicate" | "skipped" | "error";
  onSkip?: (itemId: string) => Promise<void>;
  onUnskip?: (itemId: string) => Promise<void>;
};

function getBlockedReasons(item: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  if (item.uploadStatus !== "READY") {
    reasons.push("アップロード未完了");
  }
  if (item.promptStatus !== "FILLED" && item.duplicateStatus !== "SKIPPED") {
    reasons.push("プロンプト未入力");
  }
  if (item.duplicateStatus === "DUPLICATE") {
    reasons.push("重複候補 (要解決)");
  }
  return reasons;
}

function filterItems(
  items: Record<string, unknown>[],
  activeTab: Props["activeTab"]
): Record<string, unknown>[] {
  switch (activeTab) {
    case "all":
      return items;
    case "filled":
      return items.filter(
        (i) =>
          i.uploadStatus === "READY" &&
          i.promptStatus === "FILLED" &&
          (i.duplicateStatus === "CLEAN" || i.duplicateStatus === "SKIPPED")
      );
    case "missing":
      return items.filter(
        (i) =>
          i.uploadStatus === "READY" &&
          i.promptStatus !== "FILLED" &&
          i.duplicateStatus !== "SKIPPED"
      );
    case "duplicate":
      return items.filter((i) => i.duplicateStatus === "DUPLICATE");
    case "skipped":
      return items.filter((i) => i.duplicateStatus === "SKIPPED");
    case "error":
      return items.filter(
        (i) => i.uploadStatus === "ERROR" || i.commitStatus === "FAILED"
      );
    default:
      return items;
  }
}

export default function CommitItemList({
  items,
  activeTab,
}: Props) {
  const filtered = filterItems(items, activeTab);

  return (
    <div className="flex flex-col gap-2">
      {activeTab !== "all" && (
        <p className="text-sm text-muted-foreground">
          {filtered.length}件を表示中
        </p>
      )}
      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">
          このカテゴリのアイテムはありません
        </p>
      ) : (
        filtered.map((item) => {
          const blockedReasons = getBlockedReasons(item);
          return (
            <CommitItemCard
              key={item.id as string}
              item={item}
              reasons={blockedReasons}
            />
          );
        })
      )}
    </div>
  );
}
