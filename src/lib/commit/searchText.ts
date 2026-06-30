import "server-only";

type SearchTextInput = {
  originalName?: string | null;
  promptDraft?: string | null;
  sceneName?: string | null;
  tagNames?: string[];
  personNames?: string[];
  notes?: string | null;
};

export function buildImageSearchText(input: SearchTextInput): string {
  const parts: string[] = [];
  if (input.originalName) parts.push(input.originalName);
  if (input.promptDraft) parts.push(input.promptDraft);
  if (input.sceneName) parts.push(input.sceneName);
  if (input.tagNames?.length) parts.push(...input.tagNames);
  if (input.personNames?.length) parts.push(...input.personNames);
  if (input.notes) parts.push(input.notes);
  return parts.join(" ").trim();
}
