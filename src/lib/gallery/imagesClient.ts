export type GalleryImage = {
  id: string;
  originalName: string;
  widthPx: number | null;
  heightPx: number | null;
  isFavorite: boolean;
  rating: number | null;
  createdAt: string;
  scene: { id: string; name: string } | null;
  tags: { id: string; name: string }[];
  promptSnippet: string | null;
  promptVersionCount: number;
  thumbnailUrl: string | null;
};

/** AI tag candidate awaiting review. Never a real Tag until approved. */
export type TagSuggestion = {
  id: string;
  label: string;
  confidence: number | null;
  status: "PENDING";
};

export type PromptVersionSummary = {
  id: string;
  versionType: "EDIT" | "SCENE_TRANSFORM";
  body: string;
  changeNote: string | null;
  createdAt: string;
  scene: { id: string; name: string } | null;
};

export type ImageDetail = {
  id: string;
  originalName: string;
  originalExt: string;
  mimeType: string;
  fileSizeBytes: number;
  widthPx: number | null;
  heightPx: number | null;
  fileHashSnippet: string | null;
  isFavorite: boolean;
  rating: number | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  sourceSheetName: string | null;
  sourceRow: number | null;
  sourceColumn: number | null;
  importBatchId: string | null;
  scene: { id: string; name: string } | null;
  tags: { id: string; name: string }[];
  persons: { id: string; name: string }[];
  tagSuggestions: TagSuggestion[];
  prompt: {
    id: string;
    currentBody: string;
    originalBody: string;
    createdAt: string;
    versions: PromptVersionSummary[];
  } | null;
  signedUrls: {
    thumbnailUrl: string | null;
    previewUrl: string | null;
    originalUrl: string | null;
  };
};

export type GalleryFilters = {
  q: string;
  sceneId: string | null;
  /** AND semantics (Phase 10-7B): an image must have ALL selected tags. */
  tagIds: string[];
  personId: string | null;
  favorite: boolean | null;
  sort: "newest" | "oldest";
};

export type ImagesPage = {
  images: GalleryImage[];
  nextCursor: string | null;
};

export async function fetchImages(
  filters: GalleryFilters,
  cursor: string | null,
): Promise<ImagesPage> {
  const sp = new URLSearchParams();
  if (filters.q) sp.set("q", filters.q);
  if (filters.sceneId) sp.set("sceneId", filters.sceneId);
  if (filters.tagIds.length > 0) sp.set("tagIds", filters.tagIds.join(","));
  if (filters.personId) sp.set("personId", filters.personId);
  if (filters.favorite !== null) sp.set("favorite", String(filters.favorite));
  if (filters.sort !== "newest") sp.set("sort", filters.sort);
  if (cursor) sp.set("cursor", cursor);

  const res = await fetch(`/api/images?${sp.toString()}`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? `Failed to load images (${res.status})`);
  }
  const json = (await res.json()) as { data: ImagesPage };
  return json.data;
}

export async function fetchImageDetail(id: string): Promise<ImageDetail> {
  const res = await fetch(`/api/images/${id}`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? `Failed to load image (${res.status})`);
  }
  const json = (await res.json()) as { data: ImageDetail };
  return json.data;
}

export type DeleteImageResult = {
  deleted: true;
  alreadyDeleted: boolean;
  imageId: string;
};

export async function deleteImage(id: string): Promise<DeleteImageResult> {
  const res = await fetch(`/api/images/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? `Failed to delete image (${res.status})`);
  }
  const json = (await res.json()) as { data: DeleteImageResult };
  return json.data;
}

export type ApproveSuggestionResult = {
  suggestion: { id: string; status: "APPROVED" };
  tag: { id: string; name: string } | null;
  alreadyApproved: boolean;
};

export type RejectSuggestionResult = {
  suggestion: { id: string; status: "REJECTED" };
  alreadyRejected: boolean;
};

/** Approves an AI tag candidate. `label` edits only apply while PENDING. */
export async function approveSuggestion(
  imageId: string,
  suggestionId: string,
  label?: string,
): Promise<ApproveSuggestionResult> {
  const res = await fetch(`/api/images/${imageId}/suggestions/${suggestionId}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(label !== undefined ? { label } : {}),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? `Failed to approve suggestion (${res.status})`);
  }
  const json = (await res.json()) as { data: ApproveSuggestionResult };
  return json.data;
}

export async function rejectSuggestion(
  imageId: string,
  suggestionId: string,
): Promise<RejectSuggestionResult> {
  const res = await fetch(`/api/images/${imageId}/suggestions/${suggestionId}/reject`, {
    method: "POST",
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? `Failed to reject suggestion (${res.status})`);
  }
  const json = (await res.json()) as { data: RejectSuggestionResult };
  return json.data;
}

export type RemoveImageTagResult = {
  removed: boolean;
  imageId: string;
  tagId: string;
};

/** Removes a tag from an image (ImageTag row only; the Tag itself is kept). */
export async function removeImageTag(imageId: string, tagId: string): Promise<RemoveImageTagResult> {
  const res = await fetch(`/api/images/${imageId}/tags/${tagId}`, { method: "DELETE" });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? `Failed to remove tag (${res.status})`);
  }
  const json = (await res.json()) as { data: RemoveImageTagResult };
  return json.data;
}

export type AnalyzeImageResult = {
  cached: boolean;
  analysis: {
    id: string;
    status: "DONE" | "FAILED" | "SKIPPED_NO_PROMPT";
    error: string | null;
    updatedAt: string;
    suggestions: TagSuggestion[];
  };
};

/**
 * Runs prompt-first analysis (mock provider, Phase 10-2/10-4). `force: true`
 * re-runs even if a cached DONE result matches the current prompt hash.
 */
export async function analyzeImage(
  imageId: string,
  opts?: { force?: boolean },
): Promise<AnalyzeImageResult> {
  const sp = new URLSearchParams();
  if (opts?.force) sp.set("force", "1");
  const res = await fetch(`/api/images/${imageId}/analyze?${sp.toString()}`, { method: "POST" });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      throw new Error(
        err.error?.message ??
          (retryAfter ? `しばらく待ってから再試行してください（${retryAfter}秒後）` : "リクエストが多すぎます"),
      );
    }
    throw new Error(err.error?.message ?? `Failed to analyze image (${res.status})`);
  }
  const json = (await res.json()) as { data: AnalyzeImageResult };
  // Defensive guard: the server should always populate `analysis` on a 2xx
  // response, but never trust that blindly in the UI layer.
  if (!json.data || !json.data.analysis) {
    throw new Error("解析結果を取得できませんでした");
  }
  return json.data;
}
