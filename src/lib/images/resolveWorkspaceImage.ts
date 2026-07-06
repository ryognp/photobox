import "server-only";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";

/**
 * Fetches an Image by id AND verifies the user is a member of that image's
 * workspace, in one call. The image is exposed ONLY in the `ok` branch, so a
 * route cannot structurally use image data before authorization succeeds.
 *
 * Responsibility is deliberately narrow (Phase 8B Step 2):
 * - fetch by id (caller-supplied `select`; `id` + `workspaceId` are always
 *   included internally for the membership check and downstream scoping)
 * - membership check via (image.workspaceId, userId)
 * - NO status/deletedAt interpretation (GET → 404, DELETE → idempotent 200
 *   differ, so each route decides after this returns)
 * - NO signed-URL generation, NO response shaping
 * - Image-specific only — not generalized to other models.
 *
 * This is NOT a substitute for membership checks elsewhere; it IS the
 * membership check for the images/[id] fetch-then-check routes.
 */
export type ResolveWorkspaceImageResult<T> =
  | { kind: "ok"; image: T }
  | { kind: "not_found" }
  | { kind: "forbidden" };

export async function resolveWorkspaceImage<Select extends Prisma.ImageSelect>(args: {
  id: string;
  userId: string;
  select: Select;
}): Promise<
  ResolveWorkspaceImageResult<
    Prisma.ImageGetPayload<{ select: Select }> & { id: string; workspaceId: string }
  >
> {
  // id + workspaceId are always selected regardless of caller's select.
  // Cast to Prisma.ImageSelect avoids a generic spread type conflict; the
  // precise shape is reconstructed on the return type below.
  const select = { ...args.select, id: true, workspaceId: true } as Prisma.ImageSelect;

  const image = await prisma.image.findUnique({ where: { id: args.id }, select });
  if (!image) return { kind: "not_found" };

  const workspaceId = (image as { workspaceId: string }).workspaceId;

  const member = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: { workspaceId, userId: args.userId },
    },
    select: { workspaceId: true },
  });
  if (!member) return { kind: "forbidden" };

  return {
    kind: "ok",
    image: image as Prisma.ImageGetPayload<{ select: Select }> & {
      id: string;
      workspaceId: string;
    },
  };
}
