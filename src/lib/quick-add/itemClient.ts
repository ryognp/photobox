export type SaveMode = "draft" | "filled";

export type ItemMetadata = {
  sceneId?: string | null;
  tagIds?: string[];
  personIds?: string[];
  rating?: number | null;
  isFavorite?: boolean;
  notes?: string | null;
};

export async function saveItemPrompt(
  itemId: string,
  promptDraft: string,
  saveMode: SaveMode,
): Promise<Record<string, unknown>> {
  const r = await fetch(`/api/uploads/items/${itemId}/prompt`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ promptDraft, saveMode }),
  });
  if (!r.ok) {
    const json = await r.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(json.error?.message ?? "プロンプト保存に失敗しました");
  }
  const json = await r.json() as { data: { item: Record<string, unknown> } };
  return json.data.item;
}

export async function updateItemMetadata(
  itemId: string,
  metadata: ItemMetadata,
): Promise<Record<string, unknown>> {
  const r = await fetch(`/api/uploads/items/${itemId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(metadata),
  });
  if (!r.ok) {
    const json = await r.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(json.error?.message ?? "メタデータ保存に失敗しました");
  }
  const json = await r.json() as { data: { item: Record<string, unknown> } };
  return json.data.item;
}

export type DeleteUploadItemResult = {
  deletedItemId: string;
  sessionId: string;
  sessionEmpty: boolean;
};

/**
 * Deletes a single UploadItem from a not-yet-committed session (Phase
 * 10-19A). Storage-first on the server — never leaves an orphaned DB row.
 * COMMITTED items are rejected by the server (never deletable here).
 */
export async function deleteUploadItem(itemId: string): Promise<DeleteUploadItemResult> {
  const r = await fetch(`/api/uploads/items/${itemId}`, { method: "DELETE" });
  if (!r.ok) {
    const json = await r.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(json.error?.message ?? "削除に失敗しました");
  }
  const json = await r.json() as { data: DeleteUploadItemResult };
  return json.data;
}

export async function applyPromptToItems(
  sessionId: string,
  itemIds: string[],
  promptDraft: string,
): Promise<{ updatedCount: number; items: Record<string, unknown>[] }> {
  const r = await fetch("/api/uploads/apply-prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, itemIds, promptDraft }),
  });
  if (!r.ok) {
    const json = await r.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(json.error?.message ?? "一括適用に失敗しました");
  }
  const json = await r.json() as { data: { updatedCount: number; items: Record<string, unknown>[] } };
  return json.data;
}
