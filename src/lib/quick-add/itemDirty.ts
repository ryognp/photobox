export type PromptFields = {
  promptDraft: string;
};

export type MetadataFields = {
  sceneId: string | null;
  tagIds: string[];
  personIds: string[];
  rating: number | null;
  isFavorite: boolean;
  notes: string;
};

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

export function isPromptDirty(current: PromptFields, saved: PromptFields): boolean {
  return current.promptDraft !== saved.promptDraft;
}

export function isMetadataDirty(current: MetadataFields, saved: MetadataFields): boolean {
  if (current.sceneId !== saved.sceneId) return true;
  if (current.rating !== saved.rating) return true;
  if (current.isFavorite !== saved.isFavorite) return true;
  if (current.notes !== saved.notes) return true;
  if (!sameIdSet(current.tagIds, saved.tagIds)) return true;
  if (!sameIdSet(current.personIds, saved.personIds)) return true;
  return false;
}
