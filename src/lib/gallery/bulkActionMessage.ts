// Pure success-message formatting for the Gallery bulk tag/person action UI
// (Phase 10-18D). No DOM/React import — unit-testable. Takes only the count
// fields shared by both bulk endpoints' responses (BulkAssignResult).

export type BulkActionCounts = {
  targetCount: number;
  createdLinkCount: number;
  alreadyLinkedCount: number;
};

function formatCountsSuffix(counts: BulkActionCounts): string {
  const parts: string[] = [];
  if (counts.createdLinkCount > 0) parts.push(`新規${counts.createdLinkCount}件`);
  if (counts.alreadyLinkedCount > 0) parts.push(`既存${counts.alreadyLinkedCount}件`);
  return parts.length > 0 ? `（${parts.join("、")}）` : "";
}

/** e.g. `タグ「海」を10枚に追加しました（新規8件、既存2件）` */
export function formatBulkTagSuccessMessage(name: string, counts: BulkActionCounts): string {
  return `タグ「${name}」を${counts.targetCount}枚に追加しました${formatCountsSuffix(counts)}`;
}

/** e.g. `人物「凛」を5枚に追加しました（新規5件）` */
export function formatBulkPersonSuccessMessage(name: string, counts: BulkActionCounts): string {
  return `人物「${name}」を${counts.targetCount}枚に追加しました${formatCountsSuffix(counts)}`;
}
