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
    // Phase 10-9C-3: translation cache fields (display only).
    translatedBodyJa: string | null;
    translatedFromBodyHash: string | null;
    translationStatus: "NONE" | "PENDING" | "DONE" | "FAILED" | "SKIPPED_ALREADY_JA";
    translationProvider: string | null;
    translationModel: string | null;
    translatedAt: string | null;
    translationStartedAt: string | null;
    translationError: string | null;
    // Phase 10-9C-4: server-computed effective JA translation (null when none
    // or stale). The client never recomputes this — display reads it directly.
    effectiveTranslatedBodyJa: string | null;
  } | null;
  signedUrls: {
    thumbnailUrl: string | null;
    previewUrl: string | null;
    originalUrl: string | null;
  };
  /** Phase 10-9C-3: gate for the DetailPanel translation UI (10-9C-4). */
  translationEnabled: boolean;
  /** Phase 10-11B: gate for the DetailPanel prompt-variation UI (10-11C). */
  variationEnabled: boolean;
};

/** Translation fields returned by the single-image translate API. */
export type PromptTranslation = {
  translatedBodyJa: string | null;
  translationStatus: "NONE" | "PENDING" | "DONE" | "FAILED" | "SKIPPED_ALREADY_JA";
  translationProvider: string | null;
  translationModel: string | null;
  translatedAt: string | null;
  translationError: string | null;
} | null;

export type TranslatePromptResult = {
  status: "DONE" | "FAILED" | "SKIPPED_ALREADY_JA" | "disabled" | "no_prompt" | "stale";
  translation: PromptTranslation;
  cached?: boolean;
  budget?: { remaining: number };
};

/**
 * Phase 10-9C-3: translates a single image's prompt (real provider only, gated
 * by translationEnabled). Defined for Phase 10-9C-4's DetailPanel UI — NOT yet
 * wired into any component.
 */
export async function translatePrompt(
  imageId: string,
  opts?: { force?: boolean },
): Promise<TranslatePromptResult> {
  const res = await fetch(`/api/images/${imageId}/translate-prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts?.force ? { force: true } : {}),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? `Failed to translate prompt (${res.status})`);
  }
  const json = (await res.json()) as { data: TranslatePromptResult };
  return json.data;
}

/** Phase 10-11B: fixed set of change dimensions the prompt-variation generator accepts. */
export type VariationChange = "pose" | "outfit" | "expression" | "place" | "mood_time";

export type PromptVariationResult = {
  status: "DONE" | "disabled" | "no_prompt" | "FAILED";
  variation: { text: string } | null;
  error?: string;
};

/**
 * Phase 10-11B/10-11C: generates a NEW image-generation prompt from this
 * image's existing prompt, changing only the selected dimensions. Nothing is
 * persisted server-side — the result is for display/copy only (Phase 10-11C
 * PromptVariationModal). Gated by variationEnabled.
 */
export async function generatePromptVariation(
  imageId: string,
  changes: VariationChange[],
): Promise<PromptVariationResult> {
  const res = await fetch(`/api/images/${imageId}/prompt-variations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ changes }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? `Failed to generate prompt variation (${res.status})`);
  }
  const json = (await res.json()) as { data: PromptVariationResult };
  return json.data;
}

export type GalleryFilters = {
  q: string;
  sceneId: string | null;
  /** AND semantics (Phase 10-7B): an image must have ALL selected tags. */
  tagIds: string[];
  /** AND semantics (Phase 10-9B): AI-candidate (PENDING) tag labels to filter by. */
  suggestionLabels: string[];
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
  if (filters.suggestionLabels.length > 0) sp.set("suggestionLabels", filters.suggestionLabels.join(","));
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

/** Existing Person summary as returned by /api/persons and image person links. */
export type PersonSummary = { id: string; name: string };

/**
 * Fetches the full existing-Person list for the current workspace (Phase
 * 10-15C candidate list). Read-only — never creates a Person. Kept minimal:
 * ignores /api/persons' optional `q` search param and imageCount field, since
 * the DetailPanel "人物を追加" picker only needs { id, name }.
 */
export async function fetchPersons(): Promise<PersonSummary[]> {
  const res = await fetch("/api/persons");
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? `Failed to load persons (${res.status})`);
  }
  const json = (await res.json()) as { data: PersonSummary[] };
  return json.data;
}

/**
 * Links an existing Person to an image (Phase 10-15B). personId must
 * reference a Person already in the same workspace — this never creates a
 * new Person. Idempotent server-side (safe to call again for an already
 * linked person).
 */
export async function assignImagePerson(imageId: string, personId: string): Promise<PersonSummary> {
  const res = await fetch(`/api/images/${imageId}/persons`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ personId }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? `Failed to assign person (${res.status})`);
  }
  const json = (await res.json()) as { data: { person: PersonSummary } };
  return json.data.person;
}

export type RemoveImagePersonResult = {
  removed: boolean;
  personId: string;
};

/** Unlinks a person from an image (ImagePerson row only; the Person itself is kept). */
export async function removeImagePerson(imageId: string, personId: string): Promise<RemoveImagePersonResult> {
  const res = await fetch(`/api/images/${imageId}/persons/${personId}`, { method: "DELETE" });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? `Failed to remove person (${res.status})`);
  }
  const json = (await res.json()) as { data: RemoveImagePersonResult };
  return json.data;
}

/** Existing Tag summary as returned by /api/tags and image tag links. */
export type TagSummary = { id: string; name: string };

/**
 * Fetches the full existing-Tag list for the current workspace (Phase 10-22A
 * bulk-add candidate list). Read-only — never creates a Tag. Kept minimal:
 * ignores /api/tags' optional `q` search param and imageCount field, since
 * the bulk-add picker only needs { id, name } (mirrors fetchPersons()).
 */
export async function fetchTags(): Promise<TagSummary[]> {
  const res = await fetch("/api/tags");
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? `Failed to load tags (${res.status})`);
  }
  const json = (await res.json()) as { data: TagSummary[] };
  return json.data;
}

/**
 * Adds a manually-typed tag to an image (Phase 10-16B). Finds/creates the
 * Tag by name (workspace-scoped) and attaches ImageTag — no taxonomy/synonym
 * normalization is applied, the name is used verbatim (trimmed). Idempotent
 * server-side (safe to call again for an already-attached tag name).
 */
export async function addManualImageTag(imageId: string, name: string): Promise<TagSummary> {
  const res = await fetch(`/api/images/${imageId}/tags`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? `Failed to add tag (${res.status})`);
  }
  const json = (await res.json()) as { data: { tag: TagSummary } };
  return json.data.tag;
}

/** Result shared by both bulk assignment endpoints (Phase 10-18B). */
export type BulkAssignResult = {
  requestedCount: number;
  targetCount: number;
  linkedCount: number;
  alreadyLinkedCount: number;
  createdLinkCount: number;
};

export type BulkAddTagResult = BulkAssignResult & { tag: TagSummary };

/**
 * Adds one manually-typed tag to MANY images at once (Phase 10-18B). Same
 * find-or-create-by-name semantics as addManualImageTag, applied in bulk via
 * POST /api/images/bulk/tags. Idempotent (safe to call again for images that
 * already have the tag).
 */
export async function bulkAddImageTag(imageIds: string[], name: string): Promise<BulkAddTagResult> {
  const res = await fetch("/api/images/bulk/tags", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageIds, name }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? `Failed to bulk add tag (${res.status})`);
  }
  const json = (await res.json()) as { data: BulkAddTagResult };
  return json.data;
}

export type BulkAssignPersonResult = BulkAssignResult & { person: PersonSummary };

/**
 * Links one Person (found-or-created by name) to MANY images at once (Phase
 * 10-18B) via POST /api/images/bulk/persons. Unlike assignImagePerson, this
 * can create a new Person by name — there is no single-image equivalent.
 * Idempotent (safe to call again for images that already have the person).
 */
export async function bulkAssignImagePerson(imageIds: string[], name: string): Promise<BulkAssignPersonResult> {
  const res = await fetch("/api/images/bulk/persons", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageIds, name }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? `Failed to bulk assign person (${res.status})`);
  }
  const json = (await res.json()) as { data: BulkAssignPersonResult };
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
