// Pure merge helper for quick-add commit-preview thumbnails. No Prisma, no
// Supabase, no "server-only" — unit-testable. fetchSessionWithItems() (server
// boundary) resolves signed URLs via resolveSignedUrls() and passes the
// results here to merge them onto items.
//
// Matched by request INDEX, not by id: a COMMITTED item's signed-URL request
// targets `type:"image", id: committedImageId` (not the uploadItem's own id —
// see buildThumbnailSignedUrlRequests), so id-based matching would miss it.
// resolveSignedUrls always echoes back the `index` it was given, so index is
// the one identifier guaranteed to correspond 1:1 with the items array
// position regardless of which id/type was requested for that item.
import type { SignedUrlResult } from "./signedUrl";

export type ItemThumbnailSignedUrl = { signedUrl: string | null; fallback: boolean | null };

/**
 * Attaches `signedUrls.thumbnail` to each item, matched by array position
 * against the resolved results' `index` field. An item with no matching result
 * (resolution failed / not found / forbidden) gets `signedUrls: null` — the UI
 * falls back to the placeholder icon.
 */
export function attachThumbnailSignedUrls<T>(
  items: T[],
  results: SignedUrlResult[],
): (T & { signedUrls: { thumbnail: ItemThumbnailSignedUrl } | null })[] {
  const byIndex = new Map(results.map((r) => [r.index, r]));
  return items.map((item, index) => {
    const r = byIndex.get(index);
    if (!r) return { ...item, signedUrls: null };
    return { ...item, signedUrls: { thumbnail: { signedUrl: r.signedUrl, fallback: r.fallback } } };
  });
}

export type ThumbnailSourceItem = {
  id: string;
  commitStatus: string;
  committedImageId: string | null;
};

/**
 * Builds one signed-URL request per item, in array order (index = position),
 * choosing the source of truth per item:
 * - COMMITTED + committedImageId present → the permanent Image's thumbnail
 *   (its temp uploadItem storage objects are deleted by commit cleanup, so an
 *   uploadItem-type request would sign a since-deleted path).
 * - otherwise (not yet committed — or, defensively, COMMITTED without a
 *   committedImageId, an inconsistent state that should not occur but must not
 *   throw) → the uploadItem's own temp storage.
 */
export function buildThumbnailSignedUrlRequests(
  items: ThumbnailSourceItem[],
): { index: number; type: "image" | "uploadItem"; id: string; variant: "thumbnail" }[] {
  return items.map((item, index) => {
    if (item.commitStatus === "COMMITTED" && item.committedImageId) {
      return { index, type: "image" as const, id: item.committedImageId, variant: "thumbnail" as const };
    }
    return { index, type: "uploadItem" as const, id: item.id, variant: "thumbnail" as const };
  });
}
