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
  /** AND semantics: an image must have ALL of these approved tags (Phase 10-7B). */
  tagIds: string[];
  /**
   * AND semantics (Phase 10-9B): an image must have ALL of these labels as
   * PENDING TagSuggestions. AI-candidate filter, kept separate from tagIds
   * (approved Tags). Defaults to [] when omitted (backward compatible).
   */
  suggestionLabels?: string[];
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

  // Phase 10-9B: tagIds (approved) and suggestionLabels (PENDING candidates)
  // are BOTH AND. Merge into a SINGLE `AND` array so neither overwrites the
  // other (a second `AND` key would clobber the first).
  const suggestionLabels = args.suggestionLabels ?? [];
  const andConditions: Prisma.ImageWhereInput[] = [
    ...args.tagIds.map((tagId) => ({ imageTags: { some: { tagId } } })),
    ...suggestionLabels.map((label) => ({
      tagSuggestions: { some: { status: "PENDING" as const, label, workspaceId: args.workspaceId } },
    })),
  ];

  return {
    workspaceId: args.workspaceId,
    deletedAt: null,
    status: "ACTIVE",
    ...qFilter,
    ...(args.sceneId ? { sceneId: args.sceneId } : {}),
    ...(args.favorite !== null ? { isFavorite: args.favorite } : {}),
    ...(andConditions.length > 0 ? { AND: andConditions } : {}),
    ...(args.personId ? { imagePersons: { some: { personId: args.personId } } } : {}),
  };
}
