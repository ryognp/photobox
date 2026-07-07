// Pure request-shaping and result-aggregation helpers for
// POST /api/prompts/translate-batch (Phase 10-5B). No Prisma, no fetch.
export const TRANSLATION_BATCH_LIMIT_MIN = 1;
export const TRANSLATION_BATCH_LIMIT_MAX = 50;
export const TRANSLATION_BATCH_LIMIT_DEFAULT = 20;
export const TRANSLATION_BATCH_CONCURRENCY = 3;

/** Clamps the requested batch size to [1, 50], defaulting to 20. */
export function clampBatchLimit(input: unknown): number {
  const n = typeof input === "number" && Number.isFinite(input) ? input : TRANSLATION_BATCH_LIMIT_DEFAULT;
  return Math.min(Math.max(Math.trunc(n), TRANSLATION_BATCH_LIMIT_MIN), TRANSLATION_BATCH_LIMIT_MAX);
}

export type BatchOptionsInput = {
  force?: boolean;
  retryFailedOnly?: boolean;
};

/** `force` and `retryFailedOnly` are mutually exclusive filter strategies. */
export function validateBatchOptions(input: BatchOptionsInput): { ok: true } | { ok: false; message: string } {
  if (input.force && input.retryFailedOnly) {
    return { ok: false, message: "force and retryFailedOnly are mutually exclusive" };
  }
  return { ok: true };
}

export type BatchItemOutcome = {
  imageId: string;
  status: "DONE" | "FAILED" | "SKIPPED_ALREADY_JA" | "STALE_SKIPPED";
  error?: string;
};

export type BatchSummary = {
  processed: number;
  succeeded: number;
  failed: number;
  skippedAlreadyJa: number;
  results: BatchItemOutcome[];
};

/** Aggregates per-item outcomes into the response summary shape. */
export function summarizeBatchOutcomes(outcomes: BatchItemOutcome[]): BatchSummary {
  let succeeded = 0;
  let failed = 0;
  let skippedAlreadyJa = 0;

  for (const o of outcomes) {
    if (o.status === "DONE") succeeded++;
    else if (o.status === "FAILED") failed++;
    else if (o.status === "SKIPPED_ALREADY_JA") skippedAlreadyJa++;
    // STALE_SKIPPED counts toward `processed` only (currentBody changed mid-flight).
  }

  return {
    processed: outcomes.length,
    succeeded,
    failed,
    skippedAlreadyJa,
    results: outcomes,
  };
}
