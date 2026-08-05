// Phase 10-43-B3b-1: finalize の state 分類と failure mapping の pure core。
//
// Frozen Plan（B3b 設計監査 §7 state machine / §12 failure matrix）を唯一の
// 正本として実装する。Prisma / Supabase / sharp / server-only を import せず、
// 明示的な入力（Date / status / boolean）だけから決定する。DB 更新や
// Storage I/O は行わない — B3b-2 の route はこの分類結果に従って副作用を
// 実行するだけで、分類ロジックを再実装しない。
//
// 確定契約（承認済み）:
// - OBJECT_MISSING: PREPARED + staging 不在 → 409 / PREPARED のまま / retryable
//   （client は prepare 再送で token 再発行 → 再 upload → finalize 再送）
// - FINALIZING → PREPARED という遷移は存在しない。transient 失敗は
//   FINALIZING を維持し、attemptToken 所有時のみ lease を即時解放して retry
// - measurement violation は全て fatal（FAILED）。staging object は削除しない
//   （物理削除は B3c の expiry sweep へ委譲）
// - FINALIZED + UploadItem 不在は user の正当な削除操作で到達し得る状態 →
//   404 NOT_FOUND（500 / invariant violation にしない）
// - canonical Already-Exists は既存 object を無条件に信用せず、再検証の
//   一致時のみ冪等成功。不一致は conflict（上書き禁止）

import type { ErrorCode } from "../apiResponse";
import {
  isLeaseActive,
  isPastFinalizeDeadline,
  type UploadIntentStatusValue,
} from "./uploadIntentCore";
import type { FinalizeMeasurementFailureReason } from "./finalizeMeasurement";

// ---------------------------------------------------------------------------
// 共通 rejection shape
// ---------------------------------------------------------------------------

export type IntentTransition = "none" | "expire" | "fail";

export type FinalizeRejection = {
  kind: "reject";
  http: number;
  errorCode: ErrorCode;
  // client へ返す固定文。filename / hash / path / provider message を含めない。
  message: string;
  retryable: boolean;
  // route が実行すべき intent 遷移（全て attemptToken / status 条件付き updateMany）。
  intentTransition: IntentTransition;
  // transition === "fail" 時に DB へ記録する固定分類（sanitizer 経由で保存）。
  lastErrorCode?: string;
  lastErrorDetail?: string;
  // 呼び出し元が attempt を所有している場合に lease を即時解放すべきか。
  releaseLease: boolean;
};

const reject = (r: Omit<FinalizeRejection, "kind">): FinalizeRejection => ({ kind: "reject", ...r });

// ---------------------------------------------------------------------------
// A / E. Intent read-state 分類（Frozen Plan §7）
// ---------------------------------------------------------------------------

export type FinalizeIntentSnapshot = {
  status: UploadIntentStatusValue;
  intentFinalizeDeadlineAt: Date;
  finalizeLeaseUntil: Date | null;
  cleanupLeaseUntil: Date | null;
  uploadItemId: string | null;
};

export type FinalizeSessionSnapshot = {
  status: string;
  cleanupLeaseUntil: Date | null;
};

export type FinalizeReadClassification =
  | { kind: "proceed"; recoveredStaleLease: boolean }
  | { kind: "replay" }
  | FinalizeRejection;

/**
 * download / lease CAS より前の read-side 分類。
 * 判定順序（根拠は Frozen Plan §7 / uploadIntentCore の既存優先度）:
 *   1. session 不在
 *   2. FINALIZED（replay は read-only のため session 状態より先に確定させる —
 *      response loss 後の再送が session 遷移後でも冪等 200 に収束する）
 *   3. session cleanup lease → session status
 *   4. terminal（FAILED/EXPIRED/CANCELLED）
 *   5. intent cleanup lease（既存 test「cleanup は deadline より先」を踏襲）
 *   6. finalize deadline（超過は expire 遷移つき reject）
 *   7. FINALIZING の active / stale 分岐
 *   8. PREPARED → proceed
 */
export function classifyIntentForFinalize(input: {
  now: Date;
  intent: FinalizeIntentSnapshot;
  session: FinalizeSessionSnapshot | null;
  uploadItemExists: boolean;
}): FinalizeReadClassification {
  const { now, intent, session, uploadItemExists } = input;

  if (session === null) {
    return reject({
      http: 404,
      errorCode: "NOT_FOUND",
      message: "Session not found",
      retryable: false,
      intentTransition: "none",
      releaseLease: false,
    });
  }

  if (intent.status === "FINALIZED") {
    if (uploadItemExists) return { kind: "replay" };
    // user による UploadItem hard delete 後に到達し得る正当状態。
    return reject({
      http: 404,
      errorCode: "NOT_FOUND",
      message: "Upload item not found",
      retryable: false,
      intentTransition: "none",
      releaseLease: false,
    });
  }

  if (isLeaseActive(session.cleanupLeaseUntil, now)) {
    return reject({
      http: 409,
      errorCode: "SESSION_CLEANUP_IN_PROGRESS",
      message: "This session is being cleaned up. Please retry shortly.",
      retryable: true,
      intentTransition: "none",
      releaseLease: false,
    });
  }

  if (session.status !== "ACTIVE") {
    return reject({
      http: 400,
      errorCode: "VALIDATION_ERROR",
      message: `Session status is '${session.status}'. Only ACTIVE sessions accept uploads.`,
      retryable: false,
      intentTransition: "none",
      releaseLease: false,
    });
  }

  if (intent.status === "FAILED" || intent.status === "EXPIRED" || intent.status === "CANCELLED") {
    return reject({
      http: 400,
      errorCode: "INTENT_NOT_REUSABLE",
      message: "This upload intent can no longer be used. Start a new upload.",
      retryable: false,
      intentTransition: "none",
      releaseLease: false,
    });
  }

  if (isLeaseActive(intent.cleanupLeaseUntil, now)) {
    return reject({
      http: 409,
      errorCode: "INTENT_CLEANUP_IN_PROGRESS",
      message: "This upload intent is being cleaned up.",
      retryable: true,
      intentTransition: "none",
      releaseLease: false,
    });
  }

  if (isPastFinalizeDeadline({ now, intentFinalizeDeadlineAt: intent.intentFinalizeDeadlineAt })) {
    return reject({
      http: 400,
      errorCode: "INTENT_EXPIRED",
      message: "This upload intent has expired. Start a new upload.",
      retryable: false,
      intentTransition: "expire",
      releaseLease: false,
    });
  }

  if (intent.status === "FINALIZING") {
    if (isLeaseActive(intent.finalizeLeaseUntil, now)) {
      return reject({
        http: 409,
        errorCode: "FINALIZE_IN_PROGRESS",
        message: "This upload is being finalized. Please retry shortly.",
        retryable: true,
        intentTransition: "none",
        releaseLease: false,
      });
    }
    // lease 失効 = stale attempt の回収可（FINALIZING のまま新 attemptToken で続行）。
    return { kind: "proceed", recoveredStaleLease: true };
  }

  // PREPARED
  return { kind: "proceed", recoveredStaleLease: false };
}

// ---------------------------------------------------------------------------
// B. OBJECT_MISSING 分類（Frozen Plan §5 案A）
// ---------------------------------------------------------------------------

export type StagingMissingContext = "PREPARED" | "STALE_FINALIZING";

/**
 * staging download が NOT_FOUND だった場合の分類。lease は未取得の段階で呼ぶ。
 * - PREPARED: client がまだ upload していない/失敗した通常系。intent は
 *   PREPARED のまま（遷移なし・lease 未取得）で 409 OBJECT_MISSING。
 *   client 契約: prepare 再送 → token 再発行 → upload → finalize 再送。
 * - STALE_FINALIZING: lease は object 存在確認後にのみ取得され、staging は
 *   B3c の notBefore(25h) まで誰も削除しない契約のため、この状態は外部干渉
 *   でしか発生しない → guarded FAILED（新 intent でやり直し）。
 */
export function classifyStagingObjectMissing(context: StagingMissingContext): FinalizeRejection {
  if (context === "PREPARED") {
    return reject({
      http: 409,
      errorCode: "OBJECT_MISSING",
      message: "Upload the file to storage before finalizing.",
      retryable: true,
      intentTransition: "none",
      releaseLease: false,
    });
  }
  return reject({
    http: 400,
    errorCode: "INTENT_NOT_REUSABLE",
    message: "This upload intent can no longer be used. Start a new upload.",
    retryable: false,
    intentTransition: "fail",
    lastErrorCode: "STAGING_OBJECT_LOST",
    lastErrorDetail: "Staging object disappeared before finalize completed",
    releaseLease: false,
  });
}

// ---------------------------------------------------------------------------
// C. Measurement failure mapping（Frozen Plan §12・全て fatal）
// ---------------------------------------------------------------------------

type MeasurementMapping = {
  http: number;
  errorCode: ErrorCode;
  message: string;
};

const MEASUREMENT_MAPPINGS: Record<FinalizeMeasurementFailureReason, MeasurementMapping> = {
  EMPTY_OBJECT: {
    http: 400,
    errorCode: "VALIDATION_ERROR",
    message: "The uploaded file is empty.",
  },
  PAYLOAD_TOO_LARGE: {
    http: 413,
    errorCode: "PAYLOAD_TOO_LARGE",
    message: "The uploaded file exceeds the size limit.",
  },
  DECLARED_SIZE_MISMATCH: {
    http: 400,
    errorCode: "VALIDATION_ERROR",
    message: "The uploaded file does not match the declared size.",
  },
  UNSUPPORTED_MEDIA_TYPE: {
    http: 415,
    errorCode: "UNSUPPORTED_MEDIA_TYPE",
    message: "The uploaded file is not a supported image format.",
  },
  MIME_MISMATCH: {
    http: 400,
    errorCode: "VALIDATION_ERROR",
    message: "The uploaded file does not match the declared type.",
  },
  FILE_HASH_MISMATCH: {
    http: 400,
    errorCode: "FILE_HASH_MISMATCH",
    message: "The uploaded file does not match the declared hash.",
  },
  INVALID_IMAGE: {
    http: 400,
    errorCode: "INVALID_IMAGE",
    message: "The uploaded file could not be decoded as an image.",
  },
  IMAGE_TOO_LARGE_PIXELS: {
    http: 413,
    errorCode: "IMAGE_TOO_LARGE_PIXELS",
    message: "The image exceeds the maximum pixel dimensions.",
  },
  ANIMATED_IMAGE_UNSUPPORTED: {
    http: 415,
    errorCode: "UNSUPPORTED_MEDIA_TYPE",
    message: "Animated or multi-page images are not supported.",
  },
};

/**
 * B3a measurement の fatal reason を API 応答 + intent 遷移へ写像する。
 * staging object は immutable（token upsert:false）のため、同じ入力の retry は
 * 必ず同じ結果になる — よって全て fatal（FAILED、retry は新 intent のみ）。
 * staging の物理削除はここでは要求しない（B3c sweep へ委譲）。
 */
export function mapMeasurementFailure(reason: FinalizeMeasurementFailureReason): FinalizeRejection {
  const m = MEASUREMENT_MAPPINGS[reason];
  return reject({
    http: m.http,
    errorCode: m.errorCode,
    message: m.message,
    retryable: false,
    intentTransition: "fail",
    lastErrorCode: reason,
    lastErrorDetail: m.message,
    releaseLease: true,
  });
}

// ---------------------------------------------------------------------------
// D. Transient infrastructure failure mapping（Frozen Plan §12 分類 B）
// ---------------------------------------------------------------------------

export type TransientStage =
  | "staging_download"
  | "canonical_upload"
  | "db_transaction"
  | "timeout"
  | "storage_unknown";

const TRANSIENT_LAST_ERROR: Record<TransientStage, string> = {
  staging_download: "STAGING_DOWNLOAD_FAILED",
  canonical_upload: "CANONICAL_WRITE_FAILED",
  db_transaction: "DB_TRANSACTION_FAILED",
  timeout: "FINALIZE_TIMEOUT",
  storage_unknown: "STORAGE_UNKNOWN",
};

/**
 * 一時的な infrastructure 失敗。FINALIZING を維持し（FINALIZING → PREPARED は
 * 存在しない）、attempt 所有時のみ lease を即時解放して同一 intent での retry を
 * 可能にする（失効 lease は CAS が回収する）。
 */
export function mapTransientFailure(stage: TransientStage): FinalizeRejection {
  return reject({
    http: 500,
    errorCode: "INTERNAL_ERROR",
    message: "Failed to finalize the upload. Please retry.",
    retryable: true,
    intentTransition: "none",
    lastErrorCode: TRANSIENT_LAST_ERROR[stage],
    lastErrorDetail: "Transient failure during finalize",
    releaseLease: true,
  });
}

// ---------------------------------------------------------------------------
// F. Canonical Already-Exists の再検証結果分類（Frozen Plan §9-6 案2）
// ---------------------------------------------------------------------------

export type CanonicalVerification = {
  sizeMatches: boolean;
  mimeMatches: boolean;
  hashMatches: boolean;
};

export type CanonicalConflictDecision =
  | { kind: "idempotent_success" }
  | (FinalizeRejection & { overwriteAllowed: false });

/**
 * canonical PUT が Already-Exists を返した後、既存 object を再 download して
 * 検証した結果からの決定。3 条件すべて一致した場合のみ「前 attempt の残骸」と
 * みなして冪等成功。1 つでも不一致なら conflict — 既存 object の上書きは
 * いかなる場合も許可しない。
 */
export function decideCanonicalConflict(v: CanonicalVerification): CanonicalConflictDecision {
  if (v.sizeMatches && v.mimeMatches && v.hashMatches) {
    return { kind: "idempotent_success" };
  }
  return {
    ...reject({
      http: 500,
      errorCode: "INTERNAL_ERROR",
      message: "Failed to finalize the upload. Please start a new upload.",
      retryable: false,
      intentTransition: "fail",
      lastErrorCode: "CANONICAL_OBJECT_CONFLICT",
      lastErrorDetail: "Existing canonical object does not match the staged content",
      releaseLease: true,
    }),
    overwriteAllowed: false,
  };
}

// ---------------------------------------------------------------------------
// G. Variant failure 分類（per-variant nonfatal、Frozen Plan §9-7）
// ---------------------------------------------------------------------------

export type VariantWarning =
  | "UNKNOWN_VARIANT_PROFILE"
  | "THUMBNAIL_FAILED"
  | "PREVIEW_FAILED";

export type VariantSummary = {
  // variant 失敗は intent を FAILED にしない（original だけで READY を許可）。
  fatal: false;
  warnings: VariantWarning[];
};

/**
 * variant 生成/保存結果の要約。raw error は受け取らない（boolean のみ）。
 * unknown profile は両 variant null の単一警告（B3a の fail-closed 契約に対応）。
 */
export function summarizeVariantOutcomes(input: {
  profileKnown: boolean;
  thumbnailOk: boolean;
  previewOk: boolean;
}): VariantSummary {
  if (!input.profileKnown) {
    return { fatal: false, warnings: ["UNKNOWN_VARIANT_PROFILE"] };
  }
  const warnings: VariantWarning[] = [];
  if (!input.thumbnailOk) warnings.push("THUMBNAIL_FAILED");
  if (!input.previewOk) warnings.push("PREVIEW_FAILED");
  return { fatal: false, warnings };
}
