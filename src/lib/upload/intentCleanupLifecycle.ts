// Phase 10-43-B3c-1: intent cleanup の eligibility / ownership / failure
// disposition の唯一の正本。
//
// uploadIntentCore にあった旧 cleanup eligibility（attempt 回数 10 回で retry を
// 永久停止する契約）は撤回・削除済みで、本 module が後継となる。
// 確定契約（Frozen Plan B3c v2 / SoT remediation）:
// - retryable failure は attempt 回数に関係なく再試行する（6h 毎 cron で有界）
// - terminal failure（PATH_MISMATCH / STORAGE_UNAUTHORIZED / IDENTITY_CORRUPT）
//   は dead-letter として候補から除外し、復旧は運用 runbook（手動 reset）
// - 未知・null・認識不能な failure code は安全側 = dead-letter（無限 retry へ
//   倒さない。分類不能な失敗を自動で叩き続けない）
// - storageCleanupAttemptCount は観測専用。eligibility / retry 判定に使わない
//
// module boundary（pure）:
// - Prisma / Supabase / server-only を import しない
// - Storage I/O / DB write なし・現在時刻を内部取得しない（now は入力）
// - raw provider error / raw Storage path を受け取らない（path の有無は
//   boolean で受ける）。result にも raw code / path / hash / URL を含めない
//
// 既存 primitive は再実装せず uploadIntentCore から import して使う:
//   lease 境界 = isLeaseActive（`> now` が active・`== now` は inactive）
//   expire 判断 = shouldExpireIntent（active lease 中の FINALIZING は expire しない）
//   DONE not-before = canMarkStorageCleanupDone（`now >= notBefore` でのみ許可）

import {
  isLeaseActive,
  shouldExpireIntent,
  canMarkStorageCleanupDone,
  type StorageCleanupStatusValue,
  type UploadIntentStatusValue,
} from "./uploadIntentCore";

// ---------------------------------------------------------------------------
// Failure disposition（retryable / dead-letter）
// ---------------------------------------------------------------------------

// sweep が storageCleanupLastErrorCode へ保存する固定分類（sanitizeErrorCode 済み
// 前提）。B3c-3 の candidate query はこの配列を唯一の正本として参照する。
export const RETRYABLE_CLEANUP_FAILURE_CODES = Object.freeze([
  "STORAGE_RATE_LIMITED",
  "STORAGE_UNKNOWN",
  "DB_WRITE_FAILED",
] as const);

export const TERMINAL_CLEANUP_FAILURE_CODES = Object.freeze([
  "PATH_MISMATCH",
  "STORAGE_UNAUTHORIZED",
  "IDENTITY_CORRUPT",
] as const);

export type CleanupFailureDisposition = "RETRYABLE" | "DEAD_LETTER";

const RETRYABLE_SET: ReadonlySet<string> = new Set(RETRYABLE_CLEANUP_FAILURE_CODES);

/**
 * 保存済み failure code を retryable / dead-letter へ正規化する。
 * 未知・null・空文字は安全側で DEAD_LETTER（raw code は result へ返さない）。
 */
export function classifyCleanupFailureCode(code: string | null | undefined): CleanupFailureDisposition {
  if (typeof code === "string" && RETRYABLE_SET.has(code)) return "RETRYABLE";
  return "DEAD_LETTER";
}

// ---------------------------------------------------------------------------
// C' ownership（intent が現在所有する Storage object 種別）
// ---------------------------------------------------------------------------

export type OwnedObjectKind =
  | "STAGING_ORIGINAL"
  | "CANONICAL_ORIGINAL"
  | "THUMBNAIL"
  | "PREVIEW";

/**
 * staging は常に intent 所有。canonical / variants は canonical path が存在し、
 * かつ live UploadItem が存在しない場合だけ intent 所有（live item が存在する間、
 * それらの所有権は UploadItem へ移転済みで commit / DELETE route が管理する）。
 * 戻り値は呼び出しごとに新しい配列（決定的順序・重複なし）。
 */
export function listOwnedObjectKinds(input: {
  hasCanonicalPath: boolean;
  liveUploadItemExists: boolean;
}): OwnedObjectKind[] {
  if (input.hasCanonicalPath && !input.liveUploadItemExists) {
    return ["STAGING_ORIGINAL", "CANONICAL_ORIGINAL", "THUMBNAIL", "PREVIEW"];
  }
  return ["STAGING_ORIGINAL"];
}

// ---------------------------------------------------------------------------
// Eligibility 分類
// ---------------------------------------------------------------------------

export type IntentCleanupSnapshot = {
  now: Date;
  status: UploadIntentStatusValue;
  storageCleanupStatus: StorageCleanupStatusValue;
  // sanitizeErrorCode 済みの固定分類のみが保存されている前提（raw provider
  // message は B1 sanitizer が書込み時点で遮断している）。
  storageCleanupLastErrorCode: string | null;
  // 観測専用。eligibility / retry 判定へは一切使用しない。
  storageCleanupAttemptCount: number;
  storageCleanupNotBefore: Date;
  intentFinalizeDeadlineAt: Date;
  finalizeLeaseUntil: Date | null;
  intentCleanupLeaseUntil: Date | null;
  sessionCleanupLeaseUntil: Date | null;
  // raw path は受け取らない（path 契約は cleanupPaths.ts が正本）。
  hasCanonicalPath: boolean;
  liveUploadItemExists: boolean;
};

export type IntentCleanupIneligibleReason =
  | "ALREADY_DONE"
  | "BEFORE_NOT_BEFORE"
  | "FINALIZE_IN_PROGRESS"
  | "INTENT_CLEANUP_IN_PROGRESS"
  | "SESSION_CLEANUP_IN_PROGRESS"
  | "STILL_FINALIZABLE"
  | "DEAD_LETTER";

export type IntentCleanupClassification =
  | {
      eligible: true;
      // PREPARED / FINALIZING（stale lease）を cleanup と同時に EXPIRED 化すべきか。
      expireIntent: boolean;
      ownedObjectKinds: OwnedObjectKind[];
      // storageCleanupStatus=FAILED からの retryable 再試行か（観測用）。
      retryingFailedCleanup: boolean;
    }
  | { eligible: false; reason: IntentCleanupIneligibleReason };

const ineligible = (reason: IntentCleanupIneligibleReason): IntentCleanupClassification => ({
  eligible: false,
  reason,
});

/**
 * intent 1 件の cleanup 可否・実施内容の分類（Frozen Plan の判定順序）:
 *   1. DONE → ALREADY_DONE
 *   2. now < notBefore → BEFORE_NOT_BEFORE（now == notBefore は許可）
 *   3. active finalize lease → FINALIZE_IN_PROGRESS
 *   4. active intent cleanup claim → INTENT_CLEANUP_IN_PROGRESS
 *   5. active session cleanup claim → SESSION_CLEANUP_IN_PROGRESS
 *   6. FAILED cleanup の failure disposition（dead-letter は候補外）
 *   7. PREPARED / FINALIZING がまだ finalize 可能 → STILL_FINALIZABLE（安全弁）
 *   8. eligible（expireIntent / ownedObjectKinds / retryingFailedCleanup）
 */
export function classifyIntentCleanup(input: IntentCleanupSnapshot): IntentCleanupClassification {
  const { now } = input;

  if (input.storageCleanupStatus === "DONE") return ineligible("ALREADY_DONE");

  if (!canMarkStorageCleanupDone({ now, storageCleanupNotBefore: input.storageCleanupNotBefore })) {
    return ineligible("BEFORE_NOT_BEFORE");
  }

  if (isLeaseActive(input.finalizeLeaseUntil, now)) return ineligible("FINALIZE_IN_PROGRESS");
  if (isLeaseActive(input.intentCleanupLeaseUntil, now)) return ineligible("INTENT_CLEANUP_IN_PROGRESS");
  if (isLeaseActive(input.sessionCleanupLeaseUntil, now)) return ineligible("SESSION_CLEANUP_IN_PROGRESS");

  const retryingFailedCleanup = input.storageCleanupStatus === "FAILED";
  if (retryingFailedCleanup) {
    if (classifyCleanupFailureCode(input.storageCleanupLastErrorCode) === "DEAD_LETTER") {
      return ineligible("DEAD_LETTER");
    }
  }

  // 安全弁: notBefore(25h) > finalize deadline(24h) のため通常ここへは来ないが、
  // 期限値が変更された場合でも「まだ finalize できる intent」は絶対に触らない。
  const expireIntent = shouldExpireIntent({
    now,
    status: input.status,
    intentFinalizeDeadlineAt: input.intentFinalizeDeadlineAt,
    finalizeLeaseUntil: input.finalizeLeaseUntil,
  });
  if ((input.status === "PREPARED" || input.status === "FINALIZING") && !expireIntent) {
    // active finalize lease は手順 3 で除外済みのため、ここに来る非 expire は
    // 「deadline 内」= まだ finalize 可能、のみ。
    return ineligible("STILL_FINALIZABLE");
  }

  return {
    eligible: true,
    expireIntent,
    ownedObjectKinds: listOwnedObjectKinds({
      hasCanonicalPath: input.hasCanonicalPath,
      liveUploadItemExists: input.liveUploadItemExists,
    }),
    retryingFailedCleanup,
  };
}
