import { describe, it, expect } from "vitest";
import {
  clampBatchLimit,
  validateBatchOptions,
  summarizeBatchOutcomes,
  TRANSLATION_BATCH_LIMIT_MIN,
  TRANSLATION_BATCH_LIMIT_MAX,
  TRANSLATION_BATCH_LIMIT_DEFAULT,
} from "@/lib/translation/batchPlan";

describe("clampBatchLimit", () => {
  it("defaults when omitted/invalid", () => {
    expect(clampBatchLimit(undefined)).toBe(TRANSLATION_BATCH_LIMIT_DEFAULT);
    expect(clampBatchLimit("not a number")).toBe(TRANSLATION_BATCH_LIMIT_DEFAULT);
    expect(clampBatchLimit(NaN)).toBe(TRANSLATION_BATCH_LIMIT_DEFAULT);
  });
  it("minimum is 1 (not 10)", () => {
    expect(clampBatchLimit(0)).toBe(TRANSLATION_BATCH_LIMIT_MIN);
    expect(clampBatchLimit(1)).toBe(1);
    expect(clampBatchLimit(-5)).toBe(TRANSLATION_BATCH_LIMIT_MIN);
  });
  it("clamps to max 50", () => {
    expect(clampBatchLimit(999)).toBe(TRANSLATION_BATCH_LIMIT_MAX);
  });
  it("passes through valid values, truncating floats", () => {
    expect(clampBatchLimit(20)).toBe(20);
    expect(clampBatchLimit(20.9)).toBe(20);
  });
});

describe("validateBatchOptions", () => {
  it("force + retryFailedOnly together is invalid", () => {
    const r = validateBatchOptions({ force: true, retryFailedOnly: true });
    expect(r.ok).toBe(false);
  });
  it("either alone, or neither, is valid", () => {
    expect(validateBatchOptions({ force: true }).ok).toBe(true);
    expect(validateBatchOptions({ retryFailedOnly: true }).ok).toBe(true);
    expect(validateBatchOptions({}).ok).toBe(true);
  });
});

describe("summarizeBatchOutcomes", () => {
  it("counts each status bucket, STALE_SKIPPED counted only in processed", () => {
    const summary = summarizeBatchOutcomes([
      { imageId: "a", status: "DONE" },
      { imageId: "b", status: "DONE" },
      { imageId: "c", status: "FAILED", error: "x" },
      { imageId: "d", status: "SKIPPED_ALREADY_JA" },
      { imageId: "e", status: "STALE_SKIPPED" },
    ]);
    expect(summary.processed).toBe(5);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.skippedAlreadyJa).toBe(1);
    expect(summary.results).toHaveLength(5);
  });
  it("empty input", () => {
    const summary = summarizeBatchOutcomes([]);
    expect(summary).toEqual({ processed: 0, succeeded: 0, failed: 0, skippedAlreadyJa: 0, results: [] });
  });
});
