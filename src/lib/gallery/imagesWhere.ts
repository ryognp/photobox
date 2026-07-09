// Pure `where` builder for GET /api/images (Phase 10-7B, extracted from
// route.ts's previously-inline where object). No Prisma runtime import — only
// the type is used, so this stays unit-testable without a DB connection.
// workspaceId/deletedAt/status are ALWAYS present; this is the workspace
// scoping boundary (no RLS — see docs/OPERATIONS.md).
import type { Prisma } from "@/generated/prisma/client";

export function buildImagesWhere(args: {
  workspaceId: string;
  q: string;
  sceneId: string | null;
  personId: string | null;
  favorite: boolean | null;
  /** AND semantics: an image must have ALL of these tags (Phase 10-7B decision). */
  tagIds: string[];
}): Prisma.ImageWhereInput {
  const qFilter: Prisma.ImageWhereInput = args.q
    ? {
        OR: [
          { searchText: { contains: args.q, mode: "insensitive" } },
          { originalName: { contains: args.q, mode: "insensitive" } },
          { notes: { contains: args.q, mode: "insensitive" } },
          { prompt: { currentBody: { contains: args.q, mode: "insensitive" } } },
          { prompt: { originalBody: { contains: args.q, mode: "insensitive" } } },
        ],
      }
    : {};

  return {
    workspaceId: args.workspaceId,
    deletedAt: null,
    status: "ACTIVE",
    ...qFilter,
    ...(args.sceneId ? { sceneId: args.sceneId } : {}),
    ...(args.favorite !== null ? { isFavorite: args.favorite } : {}),
    ...(args.tagIds.length > 0
      ? { AND: args.tagIds.map((tagId) => ({ imageTags: { some: { tagId } } })) }
      : {}),
    ...(args.personId ? { imagePersons: { some: { personId: args.personId } } } : {}),
  };
}
