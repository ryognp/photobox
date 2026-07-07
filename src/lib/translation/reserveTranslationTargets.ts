import "server-only";

import { Prisma } from "@/generated/prisma/client";

/**
 * Atomically selects + reserves a batch of Prompt rows for translation
 * (Phase 10-5B). Uses `FOR UPDATE SKIP LOCKED` so concurrent batch requests
 * never reserve the same row twice — a plain "SELECT candidates, then
 * updateMany" has a race window where two requests can both select the same
 * rows before either has marked them PENDING. Enum type name
 * ("TranslationStatus") and column names were confirmed against a local
 * Postgres PoC after the Phase 10-5B migration (see PR description).
 *
 * `workspaceId` is always applied — this is the sole way callers scope the
 * reservation to one workspace; there is no imageId/promptId input, so a
 * caller cannot smuggle a cross-workspace target in.
 */
export type ReservedTranslationPrompt = {
  id: string;
  workspaceId: string;
  imageId: string;
  currentBody: string;
  previousStatus: "NONE" | "PENDING" | "DONE" | "FAILED" | "SKIPPED_ALREADY_JA";
  previousTranslatedFromBodyHash: string | null;
};

/**
 * The same eligibility rule as reserveTranslationTargets' SQL, expressed as
 * a Prisma where object — for read-only counts (dryRun, `remaining`) where
 * no row locking is needed. Keep both in sync if the eligibility rule
 * changes.
 */
export function buildTranslationCandidateWhere(args: {
  workspaceId: string;
  force: boolean;
  retryFailedOnly: boolean;
  pendingStuckBefore: Date;
}): Prisma.PromptWhereInput {
  const base: Prisma.PromptWhereInput = { workspaceId: args.workspaceId };

  if (args.retryFailedOnly) {
    return { ...base, translationStatus: "FAILED" };
  }

  if (args.force) {
    return {
      ...base,
      NOT: {
        translationStatus: "PENDING",
        translationStartedAt: { not: null, gte: args.pendingStuckBefore },
      },
    };
  }

  return {
    ...base,
    OR: [
      { translationStatus: "NONE" },
      { translationStatus: "FAILED" },
      {
        translationStatus: "PENDING",
        OR: [{ translationStartedAt: null }, { translationStartedAt: { lt: args.pendingStuckBefore } }],
      },
    ],
  };
}

export async function reserveTranslationTargets(args: {
  tx: Prisma.TransactionClient;
  workspaceId: string;
  limit: number;
  force: boolean;
  retryFailedOnly: boolean;
  pendingStuckBefore: Date;
}): Promise<ReservedTranslationPrompt[]> {
  if (args.force && args.retryFailedOnly) {
    throw new Error("force and retryFailedOnly are mutually exclusive");
  }

  return args.tx.$queryRaw<ReservedTranslationPrompt[]>(Prisma.sql`
    WITH candidates AS (
      SELECT
        p.id,
        p.workspace_id,
        p.image_id,
        p.current_body,
        p.translation_status AS previous_status,
        p.translated_from_body_hash AS previous_translated_from_body_hash
      FROM prompts p
      WHERE p.workspace_id = ${args.workspaceId}
        AND (
          (
            ${args.retryFailedOnly} = true
            AND p.translation_status = 'FAILED'::"TranslationStatus"
          )
          OR (
            ${args.force} = true
            AND NOT (
              p.translation_status = 'PENDING'::"TranslationStatus"
              AND p.translation_started_at IS NOT NULL
              AND p.translation_started_at >= ${args.pendingStuckBefore}
            )
          )
          OR (
            ${args.force} = false
            AND ${args.retryFailedOnly} = false
            AND (
              p.translation_status IN ('NONE'::"TranslationStatus", 'FAILED'::"TranslationStatus")
              OR (
                p.translation_status = 'PENDING'::"TranslationStatus"
                AND (
                  p.translation_started_at IS NULL
                  OR p.translation_started_at < ${args.pendingStuckBefore}
                )
              )
            )
          )
        )
      ORDER BY p.updated_at ASC
      LIMIT ${args.limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE prompts p
    SET
      translation_status = 'PENDING'::"TranslationStatus",
      translation_started_at = NOW(),
      translation_error = NULL,
      updated_at = NOW()
    FROM candidates c
    WHERE p.id = c.id
    RETURNING
      p.id,
      p.workspace_id AS "workspaceId",
      p.image_id AS "imageId",
      c.current_body AS "currentBody",
      c.previous_status AS "previousStatus",
      c.previous_translated_from_body_hash AS "previousTranslatedFromBodyHash"
  `);
}
