// Pure cleanup orchestration for abandoned upload sessions.
// No server-only / no Prisma / no Supabase import here — dependencies are
// injected so the storage-safety invariant can be unit tested.
//
// Invariant: a session's DB record is deleted ONLY after its temp storage
// files were removed successfully. If storage removal fails, the DB record
// is retained so the next run can retry (never "DB deleted, files orphaned").

export type CleanupSession = {
  id: string;
  status: string;
  /** Temp storage paths of non-committed items in this session. */
  tempPaths: string[];
};

export type CleanupDeps = {
  /** Remove paths from storage. Returns a non-null error string on failure. */
  removeStorage: (paths: string[]) => Promise<{ error: string | null }>;
  /** Physically delete the session (cascades to items). May throw. */
  deleteSession: (id: string) => Promise<void>;
};

export type CleanupResult = {
  scannedSessions: number;
  deletedSessions: number;
  retainedSessions: number;
  deletedStoragePaths: number;
  warnings: string[];
};

export async function cleanupUploadsCore(
  sessions: CleanupSession[],
  deps: CleanupDeps,
): Promise<CleanupResult> {
  const result: CleanupResult = {
    scannedSessions: sessions.length,
    deletedSessions: 0,
    retainedSessions: 0,
    deletedStoragePaths: 0,
    warnings: [],
  };

  for (const session of sessions) {
    // Sessions with no temp files are safe to delete directly.
    if (session.tempPaths.length > 0) {
      const { error } = await deps.removeStorage(session.tempPaths);
      if (error) {
        // Storage removal failed — keep the DB record for a later retry.
        result.retainedSessions++;
        result.warnings.push(`session ${session.id}: storage remove failed (${error}); DB retained`);
        continue;
      }
      result.deletedStoragePaths += session.tempPaths.length;
    }

    try {
      await deps.deleteSession(session.id);
      result.deletedSessions++;
    } catch (e) {
      result.retainedSessions++;
      result.warnings.push(
        `session ${session.id}: DB delete failed (${e instanceof Error ? e.message : String(e)})`,
      );
    }
  }

  return result;
}
