/**
 * `withWorkspaceWhere()` composes a Prisma `where` object with a
 * `workspaceId` field. It does NOT check membership/authorization — the
 * caller is responsible for verifying the user belongs to `workspaceId`
 * before calling this (e.g. via `requireWorkspaceMember` /
 * `getDefaultWorkspaceForUserCached`).
 *
 * Scope:
 * - Prisma `where` objects only (findMany/findFirst/update/delete etc.).
 * - NOT for raw SQL — parameterize workspaceId directly via `Prisma.sql`.
 * - NOT for cron jobs that intentionally scan across all workspaces
 *   (e.g. cleanup-uploads, purge-deleted-images).
 *
 * This is a new-code convention (Phase 8B Step 1). Existing routes are not
 * being migrated in this change — see docs/OPERATIONS.md "workspace scoping
 * policy" for the phased-adoption rationale.
 */

/** `T` minus any `workspaceId` key, so callers cannot smuggle one into `extra`. */
type WithoutWorkspaceId<T> = Omit<T, "workspaceId">;

export function withWorkspaceWhere<T extends Record<string, unknown>>(
  workspaceId: string,
  extra?: WithoutWorkspaceId<T>,
): WithoutWorkspaceId<T> & { workspaceId: string } {
  // workspaceId is spread last so it always wins, even if a caller bypasses
  // the type system (e.g. via `as any`) and smuggles workspaceId into extra.
  return { ...(extra ?? ({} as WithoutWorkspaceId<T>)), workspaceId };
}
