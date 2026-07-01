import "server-only";

import { redirect } from "next/navigation";
import { prisma } from "./prisma";
import { createClient } from "./supabase/server";
import {
  getWorkspaceCache,
  setWorkspaceCache,
  type CachedWorkspace,
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
): Promise<{ workspace: CachedWorkspace | null; cacheHit: boolean }> {
  const cached = getWorkspaceCache(userId);
  if (cached) {
    return { workspace: cached, cacheHit: true };
  }

  const workspace = await getDefaultWorkspaceForUser(userId);
  if (workspace) {
    setWorkspaceCache(userId, {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      plan: workspace.plan,
    });
  }
  return { workspace: workspace ? { id: workspace.id, name: workspace.name, slug: workspace.slug, plan: workspace.plan } : null, cacheHit: false };
}
