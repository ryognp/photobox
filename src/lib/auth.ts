import "server-only";

import { redirect } from "next/navigation";
import { prisma } from "./prisma";
import { createClient } from "./supabase/server";
import {
  getWorkspaceCache,
  setWorkspaceCache,
  type CachedWorkspace,
  type WorkspaceCacheSource,
} from "./cache/workspaceCache";

export async function getCurrentUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireWorkspaceMember(workspaceId: string) {
  const user = await requireUser();

  const member = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: {
        userId: user.id,
        workspaceId,
      },
    },
  });

  if (!member) {
    throw new Error("Forbidden");
  }

  return { user, member };
}

export async function getDefaultWorkspaceForUser(userId: string) {
  const member = await prisma.workspaceMember.findFirst({
    where: { userId },
    include: { workspace: true },
    orderBy: { createdAt: "asc" },
  });
  return member?.workspace ?? null;
}

/**
 * Cached variant of getDefaultWorkspaceForUser.
 * Returns the workspace and whether it was served from cache.
 * Only positive hits are cached; null (no workspace) always hits the DB.
 */
export async function getDefaultWorkspaceForUserCached(
  userId: string,
): Promise<{ workspace: CachedWorkspace | null; cacheSource: WorkspaceCacheSource }> {
  const { workspace: cached, source } = await getWorkspaceCache(userId);
  if (cached) {
    return { workspace: cached, cacheSource: source };
  }

  const workspace = await getDefaultWorkspaceForUser(userId);
  if (workspace) {
    const w: CachedWorkspace = {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      plan: workspace.plan,
    };
    await setWorkspaceCache(userId, w);
    return { workspace: w, cacheSource: "miss" };
  }
  return { workspace: null, cacheSource: "miss" };
}
