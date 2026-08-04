import "server-only";

import type { ImageExt } from "./validateImage";

export function tempOriginalPath(workspaceId: string, sessionId: string, itemId: string, ext: ImageExt) {
  return `${workspaceId}/uploads/${sessionId}/${itemId}/original.${ext}`;
}

export function tempThumbnailPath(workspaceId: string, sessionId: string, itemId: string) {
  return `${workspaceId}/uploads/${sessionId}/${itemId}/thumbnail.webp`;
}

export function tempPreviewPath(workspaceId: string, sessionId: string, itemId: string) {
  return `${workspaceId}/uploads/${sessionId}/${itemId}/preview.webp`;
}

// Phase 10-43-B2 (Direct Upload): staging namespace for direct signed uploads.
//
// This is the ONLY path a client-held signed upload token may write to. It is
// deliberately separate from the canonical `{workspaceId}/uploads/...` temp
// namespace, which only the server writes (after finalize has verified the
// staged object). No extension: the real MIME/ext is not trusted until
// finalize measures the object's magic bytes.
//
// Every segment must be a server-generated or already-authorized id. The
// client never supplies any part of this path — in particular originalName and
// clientUploadId are never used here.

// cuid / uuid style ids only: no separators, no traversal, no NUL, no dots.
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;

export function isSafePathSegment(segment: string): boolean {
  return SAFE_PATH_SEGMENT.test(segment);
}

/**
 * Staging path for an intent's original object.
 * Throws when any segment is not a safe id — a defence-in-depth guard so a
 * traversal-shaped value can never reach Supabase, even if an upstream check
 * were bypassed.
 */
export function intentStagingOriginalPath(workspaceId: string, sessionId: string, intentId: string) {
  for (const segment of [workspaceId, sessionId, intentId]) {
    if (!isSafePathSegment(segment)) {
      // Do not include the offending value — it may be attacker-controlled.
      throw new Error("Unsafe storage path segment");
    }
  }
  return `${workspaceId}/upload-intents/${sessionId}/${intentId}/original`;
}
