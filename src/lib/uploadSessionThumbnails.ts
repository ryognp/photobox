// Pure merge helper for quick-add commit-preview thumbnails. No Prisma, no
// Supabase, no "server-only" — unit-testable. fetchSessionWithItems() (server
// boundary) resolves signed URLs via resolveSignedUrls() and passes the
// results here to merge them onto items by id.
import type { SignedUrlResult } from "./signedUrl";

export type ItemThumbnailSignedUrl = { signedUrl: string | null; fallback: boolean | null };

/**
 * Attaches `signedUrls.thumbnail` to each item, matched by item.id against the
 * resolved results (resolveSignedUrls echoes back the requested id). An item
 * with no matching result (resolution failed / item not found / forbidden)
 * gets `signedUrls: null` — the UI falls back to the placeholder icon.
 */
export function attachThumbnailSignedUrls<T extends { id: string }>(
  items: T[],
  results: SignedUrlResult[],
): (T & { signedUrls: { thumbnail: ItemThumbnailSignedUrl } | null })[] {
  const byId = new Map(results.map((r) => [r.id, r]));
  return items.map((item) => {
    const r = byId.get(item.id);
    if (!r) return { ...item, signedUrls: null };
    return { ...item, signedUrls: { thumbnail: { signedUrl: r.signedUrl, fallback: r.fallback } } };
  });
}
