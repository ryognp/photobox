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
  tagId: string | null;
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
  if (filters.tagId) sp.set("tagId", filters.tagId);
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
