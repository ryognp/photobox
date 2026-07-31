// Phase 10-43-B1: UploadIntent の pure domain core。
//
// Prisma / Supabase / server-only を import しない — 期限計算・状態遷移・lease 判定・
// cleanup eligibility を副作用なしで決められる形に閉じ込め、unit test で固定する。
// route / cron / client への接続は後続 PR で行う（B1 では未接続）。

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

// DB enum (UploadIntentStatus) と 1:1。UPLOADING / UPLOADED はサーバーが観測できない
// ため DB には存在しない（direct upload の完了は Storage 実測で確定する）。
export type UploadIntentStatusValue =
  | "PREPARED"
  | "FINALIZING"
  | "FINALIZED"
  | "FAILED"
  | "EXPIRED"
  | "CANCELLED";

export const TERMINAL_INTENT_STATUSES: readonly UploadIntentStatusValue[] = [
  "FINALIZED",
  "FAILED",
  "EXPIRED",
  "CANCELLED",
];

export function isTerminalIntentStatus(status: UploadIntentStatusValue): boolean {
  return TERMINAL_INTENT_STATUSES.includes(status);
}

// 許可される遷移のみを列挙する。terminal からの遷移は一切ない。
const ALLOWED_TRANSITIONS: Record<UploadIntentStatusValue, readonly UploadIntentStatusValue[]> = {
  PREPARED: ["FINALIZING", "FAILED", "EXPIRED", "CANCELLED"],
  FINALIZING: ["FINALIZED", "FAILED", "EXPIRED", "CANCELLED"],
  FINALIZED: [],
  FAILED: [],
  EXPIRED: [],
  CANCELLED: [],
};

export function canTransitionIntentStatus(
  from: UploadIntentStatusValue,
  to: UploadIntentStatusValue,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;

// A3 で承認済みの初期値。
// 不変条件: 発行済み token の expiry (issue + TOKEN_TTL) <= finalize deadline
//           < storage cleanup not-before。
export const TOKEN_ISSUE_DEADLINE_HOURS = 22;
export const INTENT_FINALIZE_DEADLINE_HOURS = 24;
export const STORAGE_CLEANUP_NOT_BEFORE_HOURS = 25;
// Supabase の signed upload token は固定 2 時間（P0 で TTL 7,200 秒を実測）。
export const SIGNED_UPLOAD_TOKEN_TTL_MS = 2 * HOUR_MS;

export type IntentDeadlines = {
  tokenIssueDeadlineAt: Date;
  intentFinalizeDeadlineAt: Date;
  storageCleanupNotBefore: Date;
};

export function computeIntentDeadlines(createdAt: Date): IntentDeadlines {
  const base = createdAt.getTime();
  return {
    tokenIssueDeadlineAt: new Date(base + TOKEN_ISSUE_DEADLINE_HOURS * HOUR_MS),
    intentFinalizeDeadlineAt: new Date(base + INTENT_FINALIZE_DEADLINE_HOURS * HOUR_MS),
    storageCleanupNotBefore: new Date(base + STORAGE_CLEANUP_NOT_BEFORE_HOURS * HOUR_MS),
  };
}

// token を今から発行してよいか（発行期限内か）。
export function canIssueSignedUploadToken(args: {
  now: Date;
  tokenIssueDeadlineAt: Date;
  status: UploadIntentStatusValue;
}): boolean {
  if (args.status !== "PREPARED") return false;
  return args.now.getTime() <= args.tokenIssueDeadlineAt.getTime();
}

// 発行しようとしている token の expiry が finalize 期限を超えないこと。
// tokenIssueDeadlineAt を守っていれば常に真になるが、期限値を将来変更したときに
// 不変条件が壊れたことを検知できるよう独立した述語として持つ。
export function tokenExpiryWithinFinalizeDeadline(args: {
  issuedAt: Date;
  intentFinalizeDeadlineAt: Date;
}): boolean {
  return args.issuedAt.getTime() + SIGNED_UPLOAD_TOKEN_TTL_MS <= args.intentFinalizeDeadlineAt.getTime();
}

export function isPastFinalizeDeadline(args: { now: Date; intentFinalizeDeadlineAt: Date }): boolean {
  return args.now.getTime() > args.intentFinalizeDeadlineAt.getTime();
}

// ---------------------------------------------------------------------------
// finalize lease
// ---------------------------------------------------------------------------

// finalize route の maxDuration より長くする（補助的防御。correctness の根拠ではない —
// stale writer 安全性は intent 固有 path + upsert:false + hash commitment +
// attemptToken + cleanup lease で保証する）。
export const FINALIZE_LEASE_MS = 120_000;

export type LeaseFields = {
  status: UploadIntentStatusValue;
  finalizeLeaseUntil: Date | null;
  cleanupLeaseUntil: Date | null;
};

export function isLeaseActive(leaseUntil: Date | null, now: Date): boolean {
  return leaseUntil !== null && leaseUntil.getTime() > now.getTime();
}

export function isStaleFinalizeLease(args: { finalizeLeaseUntil: Date | null; now: Date }): boolean {
  return args.finalizeLeaseUntil !== null && args.finalizeLeaseUntil.getTime() <= args.now.getTime();
}

export type FinalizeLeaseDecision =
  | { ok: true }
  | { ok: false; reason: "ALREADY_FINALIZED" | "FINALIZE_IN_PROGRESS" | "CLEANUP_IN_PROGRESS" | "PAST_DEADLINE" | "NOT_FINALIZABLE" };

// finalize lease を取得してよいかの判定（実際の取得は条件付き updateMany で行う）。
// cleanup claim が有効な間は開始しない（相互排他）。
export function canAcquireFinalizeLease(args: {
  now: Date;
  status: UploadIntentStatusValue;
  finalizeLeaseUntil: Date | null;
  cleanupLeaseUntil: Date | null;
  sessionCleanupLeaseUntil: Date | null;
  intentFinalizeDeadlineAt: Date;
}): FinalizeLeaseDecision {
  if (args.status === "FINALIZED") return { ok: false, reason: "ALREADY_FINALIZED" };
  if (isLeaseActive(args.cleanupLeaseUntil, args.now) || isLeaseActive(args.sessionCleanupLeaseUntil, args.now)) {
    return { ok: false, reason: "CLEANUP_IN_PROGRESS" };
  }
  if (isPastFinalizeDeadline({ now: args.now, intentFinalizeDeadlineAt: args.intentFinalizeDeadlineAt })) {
    return { ok: false, reason: "PAST_DEADLINE" };
  }
  if (args.status === "PREPARED") return { ok: true };
  if (args.status === "FINALIZING") {
    // lease が生きている間は他の worker を入れない。失効していれば回収できる。
    return isLeaseActive(args.finalizeLeaseUntil, args.now)
      ? { ok: false, reason: "FINALIZE_IN_PROGRESS" }
      : { ok: true };
  }
  return { ok: false, reason: "NOT_FINALIZABLE" };
}

// ---------------------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------------------

export const CLEANUP_LEASE_MS = 5 * 60 * 1000;
export const CLEANUP_BATCH_SIZE = 100;
export const CLEANUP_MAX_ATTEMPTS = 10;

export type StorageCleanupStatusValue = "PENDING" | "DONE" | "FAILED";

export type CleanupCandidate = {
  status: UploadIntentStatusValue;
  storageCleanupStatus: StorageCleanupStatusValue;
  storageCleanupAttemptCount: number;
  storageCleanupNotBefore: Date;
  intentFinalizeDeadlineAt: Date;
  finalizeLeaseUntil: Date | null;
  cleanupLeaseUntil: Date | null;
};

export type CleanupEligibility =
  | { eligible: true }
  | {
      eligible: false;
      reason:
        | "ALREADY_DONE"
        | "BEFORE_NOT_BEFORE"
        | "FINALIZE_IN_PROGRESS"
        | "CLEANUP_CLAIMED"
        | "ATTEMPTS_EXHAUSTED"
        | "STILL_FINALIZABLE";
    };

// Storage 削除の対象にしてよいか。
// storageCleanupNotBefore（= 全 token 失効 + grace）より前は絶対に削除しない。
export function evaluateCleanupEligibility(c: CleanupCandidate, now: Date): CleanupEligibility {
  if (c.storageCleanupStatus === "DONE") return { eligible: false, reason: "ALREADY_DONE" };
  if (now.getTime() < c.storageCleanupNotBefore.getTime()) {
    return { eligible: false, reason: "BEFORE_NOT_BEFORE" };
  }
  if (isLeaseActive(c.finalizeLeaseUntil, now)) return { eligible: false, reason: "FINALIZE_IN_PROGRESS" };
  if (isLeaseActive(c.cleanupLeaseUntil, now)) return { eligible: false, reason: "CLEANUP_CLAIMED" };
  if (c.storageCleanupAttemptCount >= CLEANUP_MAX_ATTEMPTS) {
    return { eligible: false, reason: "ATTEMPTS_EXHAUSTED" };
  }
  // まだ finalize できる状態（deadline 前の PREPARED / FINALIZING）は触らない。
  // storageCleanupNotBefore は finalize deadline より後なので通常ここへは来ないが、
  // 期限値を変更した場合の安全弁として残す。
  if (
    (c.status === "PREPARED" || c.status === "FINALIZING") &&
    !isPastFinalizeDeadline({ now, intentFinalizeDeadlineAt: c.intentFinalizeDeadlineAt })
  ) {
    return { eligible: false, reason: "STILL_FINALIZABLE" };
  }
  return { eligible: true };
}

// PREPARED / FINALIZING が放棄されたと見なして terminal 化できるか。
export function shouldExpireIntent(args: {
  now: Date;
  status: UploadIntentStatusValue;
  intentFinalizeDeadlineAt: Date;
  finalizeLeaseUntil: Date | null;
}): boolean {
  if (args.status !== "PREPARED" && args.status !== "FINALIZING") return false;
  if (!isPastFinalizeDeadline({ now: args.now, intentFinalizeDeadlineAt: args.intentFinalizeDeadlineAt })) {
    return false;
  }
  // FINALIZING は lease が生きている間は expire しない。
  return !isLeaseActive(args.finalizeLeaseUntil, args.now);
}

// DONE を付けてよいのは「notBefore 以降に削除が成功したとき」だけ。
// これにより DONE 後に有効 token で object が再生成される状態を禁止する。
export function canMarkStorageCleanupDone(args: { now: Date; storageCleanupNotBefore: Date }): boolean {
  return args.now.getTime() >= args.storageCleanupNotBefore.getTime();
}

// ---------------------------------------------------------------------------
// error detail
// ---------------------------------------------------------------------------

export const LAST_ERROR_DETAIL_MAX_LENGTH = 256;
export const LAST_ERROR_CODE_MAX_LENGTH = 64;

// DB 列長に収め、URL / token / 改行を落とす。ファイル名や provider の生 response を
// そのまま保存しないための最後の関門。
export function sanitizeErrorDetail(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const stripped = String(input)
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/token=[^&\s]+/gi, "token=[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length === 0) return null;
  return stripped.slice(0, LAST_ERROR_DETAIL_MAX_LENGTH);
}

export function sanitizeErrorCode(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const code = String(input).trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  if (code.length === 0) return null;
  return code.slice(0, LAST_ERROR_CODE_MAX_LENGTH);
}

// ---------------------------------------------------------------------------
// request fingerprint
// ---------------------------------------------------------------------------

// prepare payload の同一性判定に使う入力。順序固定の配列へ直列化してから hash する
// （object の key 順序に依存させない）。hash 計算自体は呼び出し側（server: node:crypto）
// が行うため、ここでは canonical string の生成だけを担う。
export type PrepareFingerprintInput = {
  sessionId: string;
  clientUploadId: string;
  originalName: string;
  declaredSizeBytes: number;
  declaredMimeType: string;
  clientFileHash: string;
};

export function canonicalFingerprintInput(input: PrepareFingerprintInput): string {
  return JSON.stringify([
    input.sessionId,
    input.clientUploadId,
    input.originalName,
    input.declaredSizeBytes,
    input.declaredMimeType,
    input.clientFileHash,
  ]);
}

// 同一 clientUploadId で payload が異なる場合は再応答してはならない。
export function isSameFingerprint(a: string, b: string): boolean {
  return a === b;
}
