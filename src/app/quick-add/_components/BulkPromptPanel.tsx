"use client";

import { useState } from "react";
import type { LocalItem } from "../types";
import { applyPromptToItems } from "@/lib/quick-add/itemClient";

type Props = {
  sessionId: string | null;
  checkedClientIds: string[];
  items: LocalItem[];
  onSuccess: (updatedItems: Record<string, unknown>[]) => void;
};

export default function BulkPromptPanel({ sessionId, checkedClientIds, items, onSuccess }: Props) {
  const [promptDraft, setPromptDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const eligibleItems = items.filter(
    (item) => checkedClientIds.includes(item.clientId) && item.serverId !== null
  );

  async function handleApply() {
    const draft = promptDraft.trim();
    if (!draft) { setError("プロンプトを入力してください"); return; }
    if (!sessionId) { setError("セッションがありません"); return; }
    if (eligibleItems.length === 0) { setError("適用できる画像がありません"); return; }

    setSaving(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const result = await applyPromptToItems(
        sessionId,
        eligibleItems.map((i) => i.serverId as string),
        draft,
      );
      setSuccessMsg(`${result.updatedCount}枚に適用しました`);
      setPromptDraft("");
      onSuccess(result.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "一括適用に失敗しました");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs font-medium text-zinc-600">
        選択中の <span className="font-bold text-zinc-900">{checkedClientIds.length}</span> 枚に同じプロンプトを適用
        {eligibleItems.length !== checkedClientIds.length && (
          <span className="ml-1 text-zinc-400">(アップロード済 {eligibleItems.length}枚が対象)</span>
        )}
      </p>
      <textarea
        rows={6}
        value={promptDraft}
        onChange={(e) => { setPromptDraft(e.target.value); setError(null); setSuccessMsg(null); }}
        placeholder="ここに共通プロンプトを入力..."
        disabled={saving}
        className="resize-none rounded-md border border-zinc-200 px-3 py-2 text-xs text-zinc-800 placeholder-zinc-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-50"
      />
      <button
        type="button"
        onClick={() => void handleApply()}
        disabled={saving || eligibleItems.length === 0}
        className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {saving ? "適用中..." : `${eligibleItems.length}枚に適用`}
      </button>
      {error && <p className="text-xs text-red-500">{error}</p>}
      {successMsg && <p className="text-xs text-green-600">{successMsg}</p>}
    </div>
  );
}
