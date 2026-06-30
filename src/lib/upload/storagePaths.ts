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
