// Pure `where` builder for GET /api/images (Phase 10-7B, extracted from
// route.ts's previously-inline where object). No Prisma runtime import — only
// the type is used, so this stays unit-testable without a DB connection.
// workspaceId/deletedAt/status are ALWAYS present; this is the workspace
// scoping boundary (no RLS — see docs/OPERATIONS.md).
import type { Prisma } from "@/generated/prisma/client";
import { getCurrentAnalysisModelIdSuffix } from "@/lib/analysis/currentAnalysisSuggestionFilter";

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
  /** Phase 10-28B: organization quick filters. All default to false/omitted
   *  (backward compatible — no behavior change when unset). Contradictory
   *  combinations with tagIds/personId (e.g. untagged + tagIds) are not
   *  specially handled — they simply yield zero rows, which is correct. */
  untagged?: boolean;
  unpersoned?: boolean;
  /** True when the image has at least one PENDING TagSuggestion produced by
   *  the CURRENT analysis prompt version (same "current model" definition as
   *  GET /api/images/[id] and GET /api/tag-suggestions — see
   *  currentAnalysisSuggestionFilter.ts). Stale-model PENDING rows never
   *  count, so this stays consistent with what DetailPanel actually shows. */
  hasSuggestions?: boolean;
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
    ...(args.untagged ? [{ imageTags: { none: {} } }] : []),
    ...(args.unpersoned ? [{ imagePersons: { none: {} } }] : []),
    ...(args.hasSuggestions
      ? [
          {
            tagSuggestions: {
              some: {
                status: "PENDING" as const,
                workspaceId: args.workspaceId,
                analysis: { modelId: { endsWith: getCurrentAnalysisModelIdSuffix() } },
              },
            },
          },
        ]
      : []),
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
