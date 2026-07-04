// Pure orchestration for physically purging Supabase Storage objects of
// soft-deleted images (DB row is kept for audit). No server-only, no Prisma,
// no Supabase imports — dependencies are injected so the storage-safe
// invariant can be unit tested.
//
// Invariant: storage objects are removed FIRST; the DB row is marked PURGED
// only after removal succeeds. On storage failure the row is marked FAILED
// (never PURGED) so the next run retries. Physical storage deletion is
// irreversible.

/** Max length stored in storage_purge_error to avoid unbounded strings. */
export const PURGE_ERROR_MAX_LEN = 500;

export type PurgeImage = {
  id: string;
  /** Candidate storage paths (storagePath/thumbnailPath/previewPath); may contain nulls/dupes. */
  paths: (string | null | undefined)[];
};

export type PurgeDeps = {
  /** Remove paths from storage. Returns a non-null error string on failure. */
  removeStorage: (paths: string[]) => Promise<{ error: string | null }>;
  /** Mark the image as PURGED (status=PURGED, purgedAt=now, purgeError=null). May throw. */
  markPurged: (id: string) => Promise<void>;
  /** Mark the image as FAILED (status=FAILED, purgeError=error). May throw. */
  markFailed: (id: string, error: string) => Promise<void>;
};

export type PurgeResult = {
  scanned: number;
  purged: number;
  failed: number;
  purgedStoragePaths: number;
  warnings: string[];
};

function uniquePaths(paths: (string | null | undefined)[]): string[] {
  return [...new Set(paths.filter((p): p is string => Boolean(p)))];
}

function truncate(s: string): string {
  return s.length > PURGE_ERROR_MAX_LEN ? s.slice(0, PURGE_ERROR_MAX_LEN) : s;
}

export async function purgeDeletedImagesCore(
  images: PurgeImage[],
  deps: PurgeDeps,
): Promise<PurgeResult> {
  const result: PurgeResult = {
    scanned: images.length,
    purged: 0,
    failed: 0,
    purgedStoragePaths: 0,
    warnings: [],
  };

  for (const img of images) {
    const paths = uniquePaths(img.paths);

    // No storage paths — do not mark PURGED (nothing verified as removed).
    if (paths.length === 0) {
      result.failed++;
      result.warnings.push(`image ${img.id}: NO_STORAGE_PATHS; not purged`);
      try {
        await deps.markFailed(img.id, "NO_STORAGE_PATHS");
      } catch (e) {
        result.warnings.push(
          `image ${img.id}: markFailed threw (${e instanceof Error ? e.message : String(e)})`,
        );
      }
      continue;
    }

    const { error } = await deps.removeStorage(paths);
    if (error) {
      // Storage removal failed — mark FAILED, retry next run. Never PURGED.
      result.failed++;
      result.warnings.push(`image ${img.id}: storage remove failed (${error})`);
      try {
        await deps.markFailed(img.id, truncate(error));
      } catch (e) {
        result.warnings.push(
          `image ${img.id}: markFailed threw (${e instanceof Error ? e.message : String(e)})`,
        );
      }
      continue;
    }

    // Storage removed successfully.
    result.purgedStoragePaths += paths.length;
    try {
      await deps.markPurged(img.id);
      result.purged++;
    } catch (e) {
      // Storage is gone but DB not marked. Do NOT count as purged; the next
      // run re-removes (idempotent — removing absent paths is a no-op) and
      // converges to PURGED. Never leaves an orphan.
      result.failed++;
      result.warnings.push(
        `image ${img.id}: storage removed but markPurged threw (${e instanceof Error ? e.message : String(e)}); will reconcile next run`,
      );
    }
  }

  return result;
}
