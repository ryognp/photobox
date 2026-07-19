"use client"

export type FilterTab = "all" | "filled" | "missing" | "duplicate" | "skipped" | "error";

type Props = {
  activeTab: FilterTab;
  onTabChange: (tab: FilterTab) => void;
  counts: {
    all: number;
    filled: number;
    missing: number;
    duplicate: number;
    skipped: number;
    error: number;
  };
};

const TAB_CONFIG: { key: FilterTab; label: string }[] = [
  { key: "all", label: "すべて" },
  { key: "filled", label: "入力済み" },
  { key: "missing", label: "未入力" },
  { key: "duplicate", label: "重複候補" },
  { key: "skipped", label: "skip済み" },
  { key: "error", label: "エラー" },
];

export function CommitFilterTabs({ activeTab, onTabChange, counts }: Props) {
  return (
    <div className="flex flex-wrap gap-1 p-1 bg-gray-100 rounded-lg">
      {TAB_CONFIG.map(({ key, label }) => {
        const isActive = activeTab === key;
        return (
          <button
            key={key}
            onClick={() => onTabChange(key)}
            className={`
              flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1
              ${isActive
                ? "bg-gray-900 text-white shadow-sm"
                : "text-gray-600 hover:bg-gray-200 hover:text-gray-900"
              }
            `}
          >
            <span>{label}</span>
            <span
              className={`
                inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full text-xs font-semibold
                ${isActive
                  ? "bg-white text-gray-900"
                  : "bg-gray-300 text-gray-700"
                }
              `}
            >
              {counts[key]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
