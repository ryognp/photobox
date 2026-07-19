"use client";

type Props = {
  sessionId: string;
  itemCount: number | null;
  onRestore: () => void;
  onDiscard: () => void;
  isLoading: boolean;
};

export default function RestoreSessionBanner({ sessionId, itemCount, onRestore, onDiscard, isLoading }: Props) {
  return (
    <div className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm">
      <span className="text-amber-800">
        前回のセッション (
        <span className="font-mono">{sessionId.slice(0, 8)}…</span>)
        を復元しますか？
        {itemCount !== null && (
          <span className="ml-1 text-amber-600">({itemCount} 件)</span>
        )}
      </span>
      <button
        onClick={onRestore}
        disabled={isLoading}
        className="rounded bg-amber-500 px-3 py-1 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1"
      >
        復元する
      </button>
      <button
        onClick={onDiscard}
        disabled={isLoading}
        className="rounded border border-amber-300 px-3 py-1 text-xs font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1"
      >
        破棄する
      </button>
    </div>
  );
}
