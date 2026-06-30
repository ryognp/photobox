import "server-only";

import { redirect } from "next/navigation";
import { prisma } from "./prisma";
import { createClient } from "./supabase/server";

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
