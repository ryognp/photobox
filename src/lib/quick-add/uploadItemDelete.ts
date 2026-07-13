// Pure helpers for deleting a single UploadItem (Phase 10-19A). No DOM/React/
// Prisma import — unit-testable. The DELETE route uses this to collect the
// temp Storage paths to remove before deleting the DB row (storage-first,
// so a storage failure never leaves an orphaned DB row with dangling paths).

export type UploadItemStoragePaths = {
  tempStoragePath: string | null;
  tempThumbnailPath: string | null;
  tempPreviewPath: string | null;
};

/** Collects the non-null temp Storage paths for a single UploadItem, in a
 *  stable order (original, thumbnail, preview). Never mutates the input. */
export function collectUploadItemStoragePaths(item: UploadItemStoragePaths): string[] {
  return [item.tempStoragePath, item.tempThumbnailPath, item.tempPreviewPath].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
}
