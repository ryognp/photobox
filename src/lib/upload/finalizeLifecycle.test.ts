import { describe, it, expect } from "vitest";
import {
  classifyIntentForFinalize,
  classifyStagingObjectMissing,
  mapMeasurementFailure,
  mapTransientFailure,
  decideCanonicalConflict,
  summarizeVariantOutcomes,
  type FinalizeIntentSnapshot,
  type FinalizeSessionSnapshot,
} from "./finalizeLifecycle";

const NOW = new Date("2026-08-05T12:00:00.000Z");
const FUTURE = new Date(NOW.getTime() + 60_000);
const PAST = new Date(NOW.getTime() - 60_000);

function intent(over: Partial<FinalizeIntentSnapshot> = {}): FinalizeIntentSnapshot {
  return {
    status: "PREPARED",
    intentFinalizeDeadlineAt: new Date(NOW.getTime() + 3600_000),
    finalizeLeaseUntil: null,
    cleanupLeaseUntil: null,
    uploadItemId: null,
    ...over,
  };
}

function session(over: Partial<FinalizeSessionSnapshot> = {}): FinalizeSessionSnapshot {
  return { status: "ACTIVE", cleanupLeaseUntil: null, ...over };
}

function classify(over: {
  intent?: Partial<FinalizeIntentSnapshot>;
  session?: Partial<FinalizeSessionSnapshot> | null;
  uploadItemExists?: boolean;
  now?: Date;
}) {
  return classifyIntentForFinalize({
    now: over.now ?? NOW,
    intent: intent(over.intent),
    session: over.session === null ? null : session(over.session ?? {}),
    uploadItemExists: over.uploadItemExists ?? false,
  });
}

// ---------------------------------------------------------------------------
// A / E. read-state 分類
// ---------------------------------------------------------------------------

describe("classifyIntentForFinalize — status 分類", () => {
  it("PREPARED 正常（期限内・cleanup 無・session ACTIVE）→ proceed", () => {
    expect(classify({})).toEqual({ kind: "proceed", recoveredStaleLease: false });
  });

  it("PREPARED + finalize 期限超過 → 400 INTENT_EXPIRED（expire 遷移つき）", () => {
    const r = classify({ intent: { intentFinalizeDeadlineAt: PAST } });
    expect(r).toMatchObject({
      kind: "reject",
      http: 400,
      errorCode: "INTENT_EXPIRED",
      retryable: false,
      intentTransition: "expire",
    });
  });

  it("active FINALIZING → 409 FINALIZE_IN_PROGRESS（retryable）", () => {
    const r = classify({ intent: { status: "FINALIZING", finalizeLeaseUntil: FUTURE } });
    expect(r).toMatchObject({
      kind: "reject",
      http: 409,
      errorCode: "FINALIZE_IN_PROGRESS",
      retryable: true,
      intentTransition: "none",
    });
  });

  it("stale FINALIZING（lease 失効）→ proceed（回収）", () => {
    const r = classify({ intent: { status: "FINALIZING", finalizeLeaseUntil: PAST } });
    expect(r).toEqual({ kind: "proceed", recoveredStaleLease: true });
  });

  it("FINALIZED + UploadItem あり → replay（冪等成功分類）", () => {
    const r = classify({
      intent: { status: "FINALIZED", uploadItemId: "item1" },
      uploadItemExists: true,
    });
    expect(r).toEqual({ kind: "replay" });
  });

  it("FINALIZED + UploadItem 削除済み → 404 NOT_FOUND（500 / invariant violation にしない）", () => {
    const r = classify({
      intent: { status: "FINALIZED", uploadItemId: "item1" },
      uploadItemExists: false,
    });
    expect(r).toMatchObject({
      kind: "reject",
      http: 404,
      errorCode: "NOT_FOUND",
      retryable: false,
      intentTransition: "none",
    });
  });

  it.each(["FAILED", "EXPIRED", "CANCELLED"] as const)(
    "terminal %s → 400 INTENT_NOT_REUSABLE",
    (status) => {
      const r = classify({ intent: { status } });
      expect(r).toMatchObject({
        kind: "reject",
        http: 400,
        errorCode: "INTENT_NOT_REUSABLE",
        retryable: false,
        intentTransition: "none",
      });
    },
  );

  it("intent cleanup lease 有効中 → 409 INTENT_CLEANUP_IN_PROGRESS", () => {
    const r = classify({ intent: { cleanupLeaseUntil: FUTURE } });
    expect(r).toMatchObject({
      kind: "reject",
      http: 409,
      errorCode: "INTENT_CLEANUP_IN_PROGRESS",
      retryable: true,
    });
  });

  it("session cleanup lease 有効中 → 409 SESSION_CLEANUP_IN_PROGRESS", () => {
    const r = classify({ session: { cleanupLeaseUntil: FUTURE } });
    expect(r).toMatchObject({
      kind: "reject",
      http: 409,
      errorCode: "SESSION_CLEANUP_IN_PROGRESS",
      retryable: true,
    });
  });

  it.each(["PREVIEWING", "ABANDONED", "COMMITTED"] as const)(
    "session %s（非 ACTIVE）→ 400 VALIDATION_ERROR",
    (status) => {
      const r = classify({ session: { status } });
      expect(r).toMatchObject({
        kind: "reject",
        http: 400,
        errorCode: "VALIDATION_ERROR",
        retryable: false,
      });
    },
  );

  it("session 不在 → 404 NOT_FOUND", () => {
    const r = classify({ session: null });
    expect(r).toMatchObject({ kind: "reject", http: 404, errorCode: "NOT_FOUND" });
  });

  it("FINALIZED replay は session 非 ACTIVE / cleanup 中でも成立する（read-only 冪等）", () => {
    expect(
      classify({
        intent: { status: "FINALIZED", uploadItemId: "i" },
        uploadItemExists: true,
        session: { status: "PREVIEWING" },
      }),
    ).toEqual({ kind: "replay" });
    expect(
      classify({
        intent: { status: "FINALIZED", uploadItemId: "i" },
        uploadItemExists: true,
        session: { cleanupLeaseUntil: FUTURE },
      }),
    ).toEqual({ kind: "replay" });
  });

  it("cleanup lease 判定は deadline 超過より先に評価される（既存 core の優先度踏襲）", () => {
    const r = classify({
      intent: { cleanupLeaseUntil: FUTURE, intentFinalizeDeadlineAt: PAST },
    });
    expect(r).toMatchObject({ errorCode: "INTENT_CLEANUP_IN_PROGRESS" });
  });
});

describe("classifyIntentForFinalize — 境界（既存述語と同一 semantics）", () => {
  it("finalize deadline ちょうどは未超過（> 判定）", () => {
    expect(classify({ intent: { intentFinalizeDeadlineAt: NOW } })).toEqual({
      kind: "proceed",
      recoveredStaleLease: false,
    });
  });

  it("finalize lease 期限ちょうどは失効扱い（回収可）", () => {
    expect(classify({ intent: { status: "FINALIZING", finalizeLeaseUntil: NOW } })).toEqual({
      kind: "proceed",
      recoveredStaleLease: true,
    });
  });

  it("cleanup lease 期限ちょうどは inactive（ブロックしない）", () => {
    expect(classify({ intent: { cleanupLeaseUntil: NOW } })).toEqual({
      kind: "proceed",
      recoveredStaleLease: false,
    });
    expect(classify({ session: { cleanupLeaseUntil: NOW } })).toEqual({
      kind: "proceed",
      recoveredStaleLease: false,
    });
  });
});

// ---------------------------------------------------------------------------
// B. OBJECT_MISSING
// ---------------------------------------------------------------------------

describe("classifyStagingObjectMissing", () => {
  it("PREPARED + missing → 409 OBJECT_MISSING・PREPARED のまま・retryable・lease 未取得", () => {
    const r = classifyStagingObjectMissing("PREPARED");
    expect(r).toMatchObject({
      kind: "reject",
      http: 409,
      errorCode: "OBJECT_MISSING",
      retryable: true,
      intentTransition: "none", // PREPARED を維持（FINALIZING へ変えない）
      releaseLease: false, // lease はそもそも取得しない分類
    });
    // resource-not-found（404）として扱わない
    expect(r.http).not.toBe(404);
    // staging 削除を要求する field が存在しない
    expect("deleteStaging" in r).toBe(false);
  });

  it("stale FINALIZING + missing → guarded FAILED（外部干渉のみで到達し得る異常）", () => {
    const r = classifyStagingObjectMissing("STALE_FINALIZING");
    expect(r).toMatchObject({
      kind: "reject",
      http: 400,
      errorCode: "INTENT_NOT_REUSABLE",
      retryable: false,
      intentTransition: "fail",
      lastErrorCode: "STAGING_OBJECT_LOST",
    });
  });
});

// ---------------------------------------------------------------------------
// C. Measurement failure mapping（全 9 reason・全て fatal）
// ---------------------------------------------------------------------------

describe("mapMeasurementFailure — Frozen Plan §12 の写像を固定", () => {
  it.each([
    ["EMPTY_OBJECT", 400, "VALIDATION_ERROR"],
    ["PAYLOAD_TOO_LARGE", 413, "PAYLOAD_TOO_LARGE"],
    ["DECLARED_SIZE_MISMATCH", 400, "VALIDATION_ERROR"],
    ["UNSUPPORTED_MEDIA_TYPE", 415, "UNSUPPORTED_MEDIA_TYPE"],
    ["MIME_MISMATCH", 400, "VALIDATION_ERROR"],
    ["FILE_HASH_MISMATCH", 400, "FILE_HASH_MISMATCH"],
    ["INVALID_IMAGE", 400, "INVALID_IMAGE"],
    ["IMAGE_TOO_LARGE_PIXELS", 413, "IMAGE_TOO_LARGE_PIXELS"],
    ["ANIMATED_IMAGE_UNSUPPORTED", 415, "UNSUPPORTED_MEDIA_TYPE"],
  ] as const)("%s → HTTP %i / %s・fatal（FAILED）・retry 不可", (reason, http, errorCode) => {
    const r = mapMeasurementFailure(reason);
    expect(r).toMatchObject({
      kind: "reject",
      http,
      errorCode,
      retryable: false,
      intentTransition: "fail",
      lastErrorCode: reason,
      releaseLease: true,
    });
    expect(typeof r.message).toBe("string");
    expect(r.message.length).toBeGreaterThan(0);
    // staging cleanup をここでは要求しない（B3c sweep へ委譲）
    expect("deleteStaging" in r).toBe(false);
  });

  it("固定 message へ filename / hash / path 等の動的値を含まない（全 reason）", () => {
    const reasons = [
      "EMPTY_OBJECT",
      "PAYLOAD_TOO_LARGE",
      "DECLARED_SIZE_MISMATCH",
      "UNSUPPORTED_MEDIA_TYPE",
      "MIME_MISMATCH",
      "FILE_HASH_MISMATCH",
      "INVALID_IMAGE",
      "IMAGE_TOO_LARGE_PIXELS",
      "ANIMATED_IMAGE_UNSUPPORTED",
    ] as const;
    for (const reason of reasons) {
      const r = mapMeasurementFailure(reason);
      // template 由来の動的埋め込みが無いこと（呼び出しごとに完全同一の固定文）
      expect(r.message).toBe(mapMeasurementFailure(reason).message);
      expect(r.lastErrorDetail).toBe(mapMeasurementFailure(reason).lastErrorDetail);
      expect(r.message).not.toMatch(/[0-9a-f]{64}|\{|\}|\//);
    }
  });
});

// ---------------------------------------------------------------------------
// D. Transient infrastructure failure
// ---------------------------------------------------------------------------

describe("mapTransientFailure", () => {
  it.each([
    ["staging_download", "STAGING_DOWNLOAD_FAILED"],
    ["canonical_upload", "CANONICAL_WRITE_FAILED"],
    ["db_transaction", "DB_TRANSACTION_FAILED"],
    ["timeout", "FINALIZE_TIMEOUT"],
    ["storage_unknown", "STORAGE_UNKNOWN"],
  ] as const)("%s → 500・FINALIZING 維持・lease 解放・retryable", (stage, lastErrorCode) => {
    const r = mapTransientFailure(stage);
    expect(r).toMatchObject({
      kind: "reject",
      http: 500,
      errorCode: "INTERNAL_ERROR",
      retryable: true,
      intentTransition: "none", // FINALIZING → PREPARED へ戻さない
      lastErrorCode,
      releaseLease: true, // attempt 所有時のみ即時解放（同一 intent で retry 可能に）
    });
    expect(r.intentTransition).not.toBe("fail");
    expect(r.intentTransition).not.toBe("expire");
  });
});

// ---------------------------------------------------------------------------
// F. Canonical Already-Exists 再検証
// ---------------------------------------------------------------------------

describe("decideCanonicalConflict", () => {
  it("size / MIME / hash 全一致 → 冪等成功（前 attempt の残骸）", () => {
    expect(
      decideCanonicalConflict({ sizeMatches: true, mimeMatches: true, hashMatches: true }),
    ).toEqual({ kind: "idempotent_success" });
  });

  it.each([
    [{ sizeMatches: false, mimeMatches: true, hashMatches: true }],
    [{ sizeMatches: true, mimeMatches: false, hashMatches: true }],
    [{ sizeMatches: true, mimeMatches: true, hashMatches: false }],
    [{ sizeMatches: false, mimeMatches: false, hashMatches: false }],
  ])("不一致 %o → conflict・上書き禁止・fatal", (v) => {
    const r = decideCanonicalConflict(v);
    expect(r).toMatchObject({
      kind: "reject",
      http: 500,
      errorCode: "INTERNAL_ERROR",
      retryable: false,
      intentTransition: "fail",
      lastErrorCode: "CANONICAL_OBJECT_CONFLICT",
      overwriteAllowed: false,
    });
  });
});

// ---------------------------------------------------------------------------
// G. Variant failure（per-variant nonfatal）
// ---------------------------------------------------------------------------

describe("summarizeVariantOutcomes", () => {
  it("thumbnail 失敗 / preview 成功 → nonfatal・THUMBNAIL_FAILED のみ", () => {
    expect(
      summarizeVariantOutcomes({ profileKnown: true, thumbnailOk: false, previewOk: true }),
    ).toEqual({ fatal: false, warnings: ["THUMBNAIL_FAILED"] });
  });

  it("preview 失敗 / thumbnail 成功 → nonfatal・PREVIEW_FAILED のみ", () => {
    expect(
      summarizeVariantOutcomes({ profileKnown: true, thumbnailOk: true, previewOk: false }),
    ).toEqual({ fatal: false, warnings: ["PREVIEW_FAILED"] });
  });

  it("両方失敗でも fatal にならない（original だけで続行可能）", () => {
    expect(
      summarizeVariantOutcomes({ profileKnown: true, thumbnailOk: false, previewOk: false }),
    ).toEqual({ fatal: false, warnings: ["THUMBNAIL_FAILED", "PREVIEW_FAILED"] });
  });

  it("unknown profile → 単一警告・nonfatal（両 variant null で original 続行）", () => {
    expect(
      summarizeVariantOutcomes({ profileKnown: false, thumbnailOk: false, previewOk: false }),
    ).toEqual({ fatal: false, warnings: ["UNKNOWN_VARIANT_PROFILE"] });
  });

  it("両成功 → 警告なし", () => {
    expect(
      summarizeVariantOutcomes({ profileKnown: true, thumbnailOk: true, previewOk: true }),
    ).toEqual({ fatal: false, warnings: [] });
  });
});

// ---------------------------------------------------------------------------
// Error privacy（全経路）
// ---------------------------------------------------------------------------

describe("error privacy — raw provider 値の非露出", () => {
  it("全 rejection の message / lastErrorDetail は固定文（URL・path・hash 形状を含まない）", () => {
    const rejections = [
      classifyStagingObjectMissing("PREPARED"),
      classifyStagingObjectMissing("STALE_FINALIZING"),
      mapMeasurementFailure("FILE_HASH_MISMATCH"),
      mapTransientFailure("staging_download"),
      decideCanonicalConflict({ sizeMatches: false, mimeMatches: true, hashMatches: true }),
    ];
    for (const r of rejections) {
      if (r.kind !== "reject") continue;
      for (const text of [r.message, r.lastErrorCode ?? "", r.lastErrorDetail ?? ""]) {
        expect(text).not.toMatch(/https?:\/\//);
        expect(text).not.toMatch(/[0-9a-f]{64}/);
        expect(text).not.toContain("upload-intents/");
        expect(text).not.toContain("token=");
      }
    }
  });
});
