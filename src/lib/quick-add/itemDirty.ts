export type PromptStatusValue = "EMPTY" | "DRAFT" | "FILLED";

export type PromptFields = {
  promptDraft: string;
  // 「ユーザーが最後に要求した保存status」(intent)。本文が同じでも
  // DRAFT→FILLED 等の未完了の保存意図を dirty として扱うために比較対象に含める。
  promptStatus: PromptStatusValue;
};

export type MetadataFields = {
  sceneId: string | null;
  tagIds: string[];
  personIds: string[];
  rating: number | null;
  isFavorite: boolean;
  notes: string;
};

// serverItem.promptStatus のような unknown 値を PromptStatusValue へ安全に解釈する。
// 欠落・未知値は fallback(既定 EMPTY — 既存データの @default(EMPTY) と整合)。
export function parsePromptStatus(
  value: unknown,
  fallback: PromptStatusValue = "EMPTY",
): PromptStatusValue {
  return value === "EMPTY" || value === "DRAFT" || value === "FILLED" ? value : fallback;
}

// saveMode と canonical promptDraft から、今回の保存が要求する promptStatus を導出する。
// サーバー側 normalizePromptStatus (src/lib/uploadItem.ts) と同じ規則:
// - draft:  本文あり → DRAFT / 空 → EMPTY
// - filled: 本文あり → FILLED / 空 → サーバーでは validation error。
//   クライアントは事前検証で保存を開始しないため到達しないが、
//   規則の対称性のため EMPTY を返す。
export function derivePromptStatus(
  promptDraft: string,
  saveMode: "draft" | "filled",
): PromptStatusValue {
  const draft = promptDraft.trim();
  if (saveMode === "draft") return draft ? "DRAFT" : "EMPTY";
  return draft ? "FILLED" : "EMPTY";
}

// サーバーが実際に保存する意味上の値(canonical)へ正規化する。
// - promptDraft: サーバー側(PUT /api/uploads/items/[id]/prompt)で trim() されるため trim。
//   空(null保存)は canonical 上 "" で表す。promptStatus はそのまま(完全一致比較)。
// - notes: 送信時に trim() || null とし、サーバーもそのまま保存するため trim。
//   null 相当は canonical 上 "" で表す。
// 前後空白だけの差はサーバー上で保存されない差なので、dirty 判定に含めない。
export function canonicalizePrompt(fields: PromptFields): PromptFields {
  return { promptDraft: fields.promptDraft.trim(), promptStatus: fields.promptStatus };
}

// tagIds/personIds は配列をコピーして返す。呼び出し元がスナップショットとして
// 保持したあとに元の配列が変更されても、スナップショットは影響を受けない。
export function canonicalizeMetadata(fields: MetadataFields): MetadataFields {
  return {
    sceneId: fields.sceneId,
    tagIds: [...fields.tagIds],
    personIds: [...fields.personIds],
    rating: fields.rating,
    isFavorite: fields.isFavorite,
    notes: fields.notes.trim(),
  };
}

// tagIds/personIds は並び順に意味がないため、集合として比較する。
function sameIdSet(a: string[], b: string[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const id of setB) {
    if (!setA.has(id)) return false;
  }
  return true;
}

// 両引数とも内部で canonical 化してから比較する(生のUI値をそのまま渡してよい)。
// 本文(canonical)と promptStatus のどちらかが異なれば dirty。
export function isPromptDirty(current: PromptFields, saved: PromptFields): boolean {
  const c = canonicalizePrompt(current);
  const s = canonicalizePrompt(saved);
  if (c.promptDraft !== s.promptDraft) return true;
  if (c.promptStatus !== s.promptStatus) return true;
  return false;
}

export function isMetadataDirty(current: MetadataFields, saved: MetadataFields): boolean {
  const c = canonicalizeMetadata(current);
  const s = canonicalizeMetadata(saved);
  if (c.sceneId !== s.sceneId) return true;
  if (c.rating !== s.rating) return true;
  if (c.isFavorite !== s.isFavorite) return true;
  if (c.notes !== s.notes) return true;
  if (!sameIdSet(c.tagIds, s.tagIds)) return true;
  if (!sameIdSet(c.personIds, s.personIds)) return true;
  return false;
}

// 「保存して次へ」系の保存が両方成功したあと、自動で次のアイテムへ進んでよいかの判定。
// 保存中(リクエスト送信後)にユーザーが値を変更していた場合 — つまり最新UI値が
// 今回実際に保存された snapshot と canonical 比較で異なる場合 — は進まない。
// promptStatus intent も比較対象(本文が同じでも status が違えば進まない)。
// 保存中に変更しても、元の canonical 値へ戻されていれば進んでよい。
export function canAdvanceAfterSave(args: {
  currentPrompt: PromptFields;
  savedPrompt: PromptFields;
  currentMetadata: MetadataFields;
  savedMetadata: MetadataFields;
}): boolean {
  return (
    !isPromptDirty(args.currentPrompt, args.savedPrompt) &&
    !isMetadataDirty(args.currentMetadata, args.savedMetadata)
  );
}
