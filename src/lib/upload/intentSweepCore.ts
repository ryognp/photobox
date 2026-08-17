// Phase 10-43-B3c-3: intent storage cleanup sweep の runtime core。
//
// 責務: candidate 取得 → eligibility 分類 → cleanup claim 取得（session row lock
// 順序）→ path plan 生成 → Storage remove → 成功 / retryable / terminal の DB 確定
// → 固定 metrics 返却。
//
// state machine / path grammar はこの module で再実装しない — 唯一の正本:
//   eligibility  = intentCleanupLifecycle.classifyIntentCleanup()
//   failure 分類 = intentCleanupLifecycle.classifyCleanupFailureCode()
//   claim 判定   = cleanupClaimCore.decideClaim() / ownsClaim()
//   DONE 境界    = uploadIntentCore.canMarkStorageCleanupDone()
//   path plan    = cleanupPaths.planIntentCleanupPaths()
//   Storage 正規化 = storageErrors.normalizeStorageError()
//
// module boundary（server-domain）:
// - Client Component から import しない（cleanupPaths → storagePaths が
//   transitive に server-only）
// - 現在時刻・attempt token・Prisma・Storage は全て dependency 注入
// - result / warning へ raw path・raw provider message・claim token・
//   lease timestamp を含めない（intentId / sessionId / workspaceId /
//   固定分類コード / 件数のみ）
//
// 確定 runtime 契約（B3c-3 承認済み）:
// - batch = INTENT_SWEEP_BATCH_SIZE(100) / invocation
// - Storage remove = 最大 STORAGE_REMOVE_BATCH_SIZE(100) paths / call
// - claim lease = 既存正本 CLEANUP_LEASE_MS(5 分) を再利用（再定義しない）
// - retryable failure は attempt 回数に関係なく再試行（上限 gate を定義しない）
// - terminal failure は dead-letter（自動 retry 対象外・毎 run 可視化）
// - missing Storage object は冪等成功
// - Storage 削除成功前に DB 行の cleanup を DONE にしない / DB 行は削除しない

import {
  CLEANUP_BATCH_SIZE,
  canMarkStorageCleanupDone,
  type StorageCleanupStatusValue,
  type UploadIntentStatusValue,
} from "./uploadIntentCore";
import {
  classifyCleanupFailureCode,
  classifyIntentCleanup,
  RETRYABLE_CLEANUP_FAILURE_CODES,
} from "./intentCleanupLifecycle";
import { decideClaim, ownsClaim } from "./cleanupClaimCore";
import { planIntentCleanupPaths } from "./cleanupPaths";
import { normalizeStorageError } from "./storageErrors";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";

// ---------------------------------------------------------------------------
// Runtime 定数（既存正本を再利用。route で再定義しない）
// ---------------------------------------------------------------------------

// intent sweep の 1 invocation あたりの上限。正本は uploadIntentCore の
// CLEANUP_BATCH_SIZE（100）— 別の数値をここへ直書きしない。
export const INTENT_SWEEP_BATCH_SIZE = CLEANUP_BATCH_SIZE;

// Supabase Storage remove(paths) の 1 call あたりの最大 path 数。
export const STORAGE_REMOVE_BATCH_SIZE = 100;

// ---------------------------------------------------------------------------
// Storage remove（batched・missing 冪等成功・固定分類）
// ---------------------------------------------------------------------------

// provider adapter の戻り値。error は raw のまま受け取り、この module 内の
// normalizeStorageError() だけが解釈する（呼び出し側で message match しない）。
// removedPaths は provider が削除を報告した path 一覧（null = 報告なし）。
export type StorageRemoveResponse = {
  error: unknown;
  removedPaths?: readonly string[] | null;
};

export type StorageRemover = (paths: readonly string[]) => Promise<StorageRemoveResponse>;

// remove 失敗時に storageCleanupLastErrorCode へ保存する固定分類のみ。
export type StorageRemoveFailureCode =
  | "STORAGE_UNAUTHORIZED"
  | "STORAGE_RATE_LIMITED"
  | "STORAGE_UNKNOWN";

export type BatchedRemoveResult =
  | { ok: true; deleted: number; missing: number }
  // 失敗 batch より前の進捗（deleted / missing）は保持する。DB 行は残し、
  // 削除済み path は次回 missing として冪等成功へ収束する。
  | { ok: false; errorCode: StorageRemoveFailureCode; deleted: number; missing: number };

/**
 * paths を STORAGE_REMOVE_BATCH_SIZE 以下の batch へ分割して順に削除する。
 * - provider が NOT_FOUND を返した batch は全 path を missing = 冪等成功として扱う
 * - 成功 response で削除一覧に無い path も missing = 冪等成功
 * - それ以外の失敗は固定分類で打ち切る（後続 batch は次回再試行）
 */
export async function removeStoragePathsInBatches(
  remove: StorageRemover,
  paths: readonly string[],
  batchSize: number = STORAGE_REMOVE_BATCH_SIZE,
): Promise<BatchedRemoveResult> {
  const size = Math.max(1, Math.min(batchSize, STORAGE_REMOVE_BATCH_SIZE));
  let deleted = 0;
  let missing = 0;

  for (let i = 0; i < paths.length; i += size) {
    const batch = paths.slice(i, i + size);
    let response: StorageRemoveResponse;
    try {
      response = await remove(batch);
    } catch (e) {
      response = { error: e };
    }

    if (response.error !== null && response.error !== undefined) {
      const normalized = normalizeStorageError(response.error);
      if (normalized.code === "STORAGE_OBJECT_NOT_FOUND") {
        missing += batch.length;
        continue;
      }
      const errorCode: StorageRemoveFailureCode =
        normalized.code === "STORAGE_UNAUTHORIZED"
          ? "STORAGE_UNAUTHORIZED"
          : normalized.code === "STORAGE_RATE_LIMITED"
            ? "STORAGE_RATE_LIMITED"
            : "STORAGE_UNKNOWN";
      return { ok: false, errorCode, deleted, missing };
    }

    if (response.removedPaths === null || response.removedPaths === undefined) {
      // provider が削除一覧を報告しない場合は全件削除成功として扱う。
      deleted += batch.length;
      continue;
    }
    const removedSet = new Set(response.removedPaths);
    for (const path of batch) {
      if (removedSet.has(path)) deleted += 1;
      else missing += 1;
    }
  }

  return { ok: true, deleted, missing };
}

// ---------------------------------------------------------------------------
// Store interface（DB 依存の注入点）
// ---------------------------------------------------------------------------

export type IntentSweepCandidate = {
  id: string;
  workspaceId: string;
  sessionId: string;
  reservedUploadItemId: string;
  status: UploadIntentStatusValue;
  storageCleanupStatus: StorageCleanupStatusValue;
  storageCleanupLastErrorCode: string | null;
  storageCleanupAttemptCount: number;
  storageCleanupNotBefore: Date;
  intentFinalizeDeadlineAt: Date;
  finalizeLeaseUntil: Date | null;
  cleanupLeaseUntil: Date | null;
  sessionCleanupLeaseUntil: Date | null;
  stagingOriginalPath: string;
  canonicalOriginalPath: string | null;
  liveUploadItemExists: boolean;
};

// claim 後の再読込 snapshot。token は所有権確認（ownsClaim）にのみ使い、
// result / warning へは出さない。
export type IntentSweepSnapshot = IntentSweepCandidate & {
  cleanupAttemptToken: string | null;
};

export type IntentClaimOutcome = "claimed" | "session_blocked" | "conflict";

export type IntentSweepStore = {
  /** candidate 取得（notBefore <= now・PENDING または retryable FAILED・batch 上限）。 */
  listCandidates(args: { now: Date; take: number }): Promise<IntentSweepCandidate[]>;
  /** terminal dead-letter の毎 run 可視化（candidate からは除外されている）。 */
  countDeadLetters(): Promise<{ total: number; byCode: Record<string, number> }>;
  /**
   * 短い transaction 内で session row guard → intent 条件付き claim を行う。
   * lock 順序は必ず UploadSession row → UploadIntent row（逆順禁止）。
   */
  claimIntent(args: {
    intentId: string;
    sessionId: string;
    workspaceId: string;
    expectedStatus: UploadIntentStatusValue;
    expectedCleanupStatus: StorageCleanupStatusValue;
    expireIntent: boolean;
    attemptToken: string;
    leaseUntil: Date;
    now: Date;
  }): Promise<IntentClaimOutcome>;
  /** claim 後の stable snapshot 再読込。 */
  readIntentSnapshot(intentId: string): Promise<IntentSweepSnapshot | null>;
  /** token 所有権条件付きの DONE 確定。false = claim 喪失（上書きしない）。 */
  confirmCleanupDone(args: { intentId: string; attemptToken: string; now: Date }): Promise<boolean>;
  /** token 所有権条件付きの FAILED 記録（lease / token は clear）。 */
  recordCleanupFailure(args: { intentId: string; attemptToken: string; errorCode: string }): Promise<boolean>;
  /** token 所有権条件付きの claim 解放（status / lastError は変更しない）。 */
  releaseIntentClaim(args: { intentId: string; attemptToken: string }): Promise<void>;
};

// ---------------------------------------------------------------------------
// Sweep result（固定 metrics のみ）
// ---------------------------------------------------------------------------

export type IntentSweepResult = {
  candidates: number;
  skipped: number;
  claimed: number;
  cleaned: number;
  expired: number;
  retryableFailed: number;
  terminalFailed: number;
  storageDeleted: number;
  storageMissing: number;
  storageFailed: number;
  deadLetterTotal: number;
  deadLetterByCode: Record<string, number>;
  // 固定分類 + id のみ（raw path / provider message / token を含めない）。
  warnings: string[];
};

export type IntentSweepDeps = {
  store: IntentSweepStore;
  removeStorage: StorageRemover;
  now: () => Date;
  generateAttemptToken: () => string;
};

/**
 * intent sweep の 1 invocation。candidate ごとに失敗を分離し、1 件の失敗で
 * run 全体を throw させない。
 */
export async function runIntentSweep(
  deps: IntentSweepDeps,
  options?: { batchSize?: number },
): Promise<IntentSweepResult> {
  const take = Math.max(1, Math.min(options?.batchSize ?? INTENT_SWEEP_BATCH_SIZE, INTENT_SWEEP_BATCH_SIZE));

  const result: IntentSweepResult = {
    candidates: 0,
    skipped: 0,
    claimed: 0,
    cleaned: 0,
    expired: 0,
    retryableFailed: 0,
    terminalFailed: 0,
    storageDeleted: 0,
    storageMissing: 0,
    storageFailed: 0,
    deadLetterTotal: 0,
    deadLetterByCode: {},
    warnings: [],
  };

  const deadLetters = await deps.store.countDeadLetters();
  result.deadLetterTotal = deadLetters.total;
  result.deadLetterByCode = { ...deadLetters.byCode };

  const candidates = await deps.store.listCandidates({ now: deps.now(), take });
  result.candidates = candidates.length;

  for (const candidate of candidates) {
    let claimedToken: string | null = null;
    try {
      const now = deps.now();

      // --- 1. claim 前 eligibility（唯一の正本 classifier を使用） ---------
      const preClassification = classifyIntentCleanup({
        now,
        status: candidate.status,
        storageCleanupStatus: candidate.storageCleanupStatus,
        storageCleanupLastErrorCode: candidate.storageCleanupLastErrorCode,
        storageCleanupAttemptCount: candidate.storageCleanupAttemptCount,
        storageCleanupNotBefore: candidate.storageCleanupNotBefore,
        intentFinalizeDeadlineAt: candidate.intentFinalizeDeadlineAt,
        finalizeLeaseUntil: candidate.finalizeLeaseUntil,
        intentCleanupLeaseUntil: candidate.cleanupLeaseUntil,
        sessionCleanupLeaseUntil: candidate.sessionCleanupLeaseUntil,
        hasCanonicalPath: candidate.canonicalOriginalPath !== null,
        liveUploadItemExists: candidate.liveUploadItemExists,
      });
      if (!preClassification.eligible) {
        result.skipped += 1;
        continue;
      }

      // --- 2. claim 判定（pure）と条件付き取得（DB） ------------------------
      const attemptToken = deps.generateAttemptToken();
      const claimDecision = decideClaim({
        now,
        state: { cleanupLeaseUntil: candidate.cleanupLeaseUntil, cleanupAttemptToken: null },
        attemptToken,
      });
      if (!claimDecision.ok) {
        result.skipped += 1;
        continue;
      }

      const claimOutcome = await deps.store.claimIntent({
        intentId: candidate.id,
        sessionId: candidate.sessionId,
        workspaceId: candidate.workspaceId,
        expectedStatus: candidate.status,
        expectedCleanupStatus: candidate.storageCleanupStatus,
        expireIntent: preClassification.expireIntent,
        attemptToken,
        leaseUntil: claimDecision.leaseUntil,
        now,
      });
      if (claimOutcome !== "claimed") {
        // count 0 は一般 500 にしない — 競合として skip し次回 run が再分類する。
        result.skipped += 1;
        continue;
      }
      claimedToken = attemptToken;
      result.claimed += 1;

      // --- 3. claim 後の stable snapshot 再読込 + 再分類 --------------------
      const snapshot = await deps.store.readIntentSnapshot(candidate.id);
      if (
        !snapshot ||
        !ownsClaim({
          state: {
            cleanupLeaseUntil: snapshot.cleanupLeaseUntil,
            cleanupAttemptToken: snapshot.cleanupAttemptToken,
          },
          attemptToken,
        })
      ) {
        // claim を失った（他 worker が取り直した）— 何も上書きしない。
        claimedToken = null;
        result.warnings.push(`intent ${candidate.id}: cleanup claim lost after acquisition`);
        continue;
      }

      const postNow = deps.now();
      const postClassification = classifyIntentCleanup({
        now: postNow,
        status: snapshot.status,
        storageCleanupStatus: snapshot.storageCleanupStatus,
        // claim update は lastErrorCode を clear する（自分の書込み）。FAILED +
        // null を dead-letter と誤分類しないよう、再分類には claim 前の
        // candidate 値を使う（他 worker の変化は ownsClaim / status 差分で検出）。
        storageCleanupLastErrorCode: candidate.storageCleanupLastErrorCode,
        storageCleanupAttemptCount: snapshot.storageCleanupAttemptCount,
        storageCleanupNotBefore: snapshot.storageCleanupNotBefore,
        intentFinalizeDeadlineAt: snapshot.intentFinalizeDeadlineAt,
        finalizeLeaseUntil: snapshot.finalizeLeaseUntil,
        // 自分の claim lease は除外して再分類する（他 worker の claim は
        // ownsClaim の token 不一致で既に検出済み）。
        intentCleanupLeaseUntil: null,
        sessionCleanupLeaseUntil: snapshot.sessionCleanupLeaseUntil,
        hasCanonicalPath: snapshot.canonicalOriginalPath !== null,
        liveUploadItemExists: snapshot.liveUploadItemExists,
      });
      if (!postClassification.eligible) {
        await deps.store.releaseIntentClaim({ intentId: candidate.id, attemptToken });
        claimedToken = null;
        result.skipped += 1;
        continue;
      }

      // --- 4. path plan（DB 値は再計算 expected と完全一致した場合のみ） ----
      const plan = planIntentCleanupPaths({
        workspaceId: snapshot.workspaceId,
        sessionId: snapshot.sessionId,
        intentId: snapshot.id,
        reservedUploadItemId: snapshot.reservedUploadItemId,
        stagingOriginalPath: snapshot.stagingOriginalPath,
        canonicalOriginalPath: snapshot.canonicalOriginalPath,
        liveUploadItemExists: snapshot.liveUploadItemExists,
      });
      if (!plan.ok) {
        // fail-closed: Storage remove 0。terminal として dead-letter へ。
        await deps.store
          .recordCleanupFailure({ intentId: candidate.id, attemptToken, errorCode: plan.reason })
          .catch(() => false);
        claimedToken = null;
        result.terminalFailed += 1;
        result.warnings.push(`intent ${candidate.id}: cleanup path plan failed (${plan.reason})`);
        continue;
      }

      // --- 5. Storage remove（transaction 外・batched・missing 冪等成功） ---
      const removeResult = await removeStoragePathsInBatches(
        deps.removeStorage,
        plan.entries.map((entry) => entry.path),
      );
      result.storageDeleted += removeResult.deleted;
      result.storageMissing += removeResult.missing;

      if (!removeResult.ok) {
        result.storageFailed += 1;
        const disposition = classifyCleanupFailureCode(removeResult.errorCode);
        const recorded = await deps.store
          .recordCleanupFailure({ intentId: candidate.id, attemptToken, errorCode: removeResult.errorCode })
          .catch(() => false);
        claimedToken = null;
        if (disposition === "RETRYABLE") result.retryableFailed += 1;
        else result.terminalFailed += 1;
        result.warnings.push(
          `intent ${candidate.id}: storage remove failed (${removeResult.errorCode})${recorded ? "" : "; failure record skipped (claim lost or DB write failed)"}`,
        );
        continue;
      }

      // --- 6. DONE 確定（token 所有権 + notBefore 条件付き） ----------------
      const doneNow = deps.now();
      if (!canMarkStorageCleanupDone({ now: doneNow, storageCleanupNotBefore: snapshot.storageCleanupNotBefore })) {
        // 安全弁: candidate 段階で notBefore <= now を要求済みのため通常到達しない。
        await deps.store.releaseIntentClaim({ intentId: candidate.id, attemptToken });
        claimedToken = null;
        result.skipped += 1;
        continue;
      }

      let confirmed: boolean;
      try {
        confirmed = await deps.store.confirmCleanupDone({ intentId: candidate.id, attemptToken, now: doneNow });
      } catch {
        // Storage 削除は成功済み。DB 行は削除せず FAILED(DB_WRITE_FAILED) を試み、
        // それも失敗したら claim lease expiry 後の再試行に委ねる。次回 run は
        // missing → 冪等成功 → DONE 確定の再試行へ収束する。
        await deps.store
          .recordCleanupFailure({ intentId: candidate.id, attemptToken, errorCode: "DB_WRITE_FAILED" })
          .catch(() => false);
        claimedToken = null;
        result.retryableFailed += 1;
        result.warnings.push(`intent ${candidate.id}: cleanup done write failed (DB_WRITE_FAILED)`);
        continue;
      }
      claimedToken = null;
      if (!confirmed) {
        // token 喪失 — 他 worker の状態を上書きしない。
        result.warnings.push(`intent ${candidate.id}: cleanup done skipped (claim token no longer owned)`);
        continue;
      }

      result.cleaned += 1;
      if (preClassification.expireIntent) result.expired += 1;
    } catch {
      // candidate 間の失敗分離: 1 件の想定外失敗で run を落とさない。
      result.warnings.push(`intent ${candidate.id}: sweep failed (UNEXPECTED)`);
      if (claimedToken !== null) {
        await deps.store
          .releaseIntentClaim({ intentId: candidate.id, attemptToken: claimedToken })
          .catch(() => undefined);
        claimedToken = null;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Prisma-backed store（route / cron から使う唯一の実装）
// ---------------------------------------------------------------------------

const CANDIDATE_SELECT = {
  id: true,
  workspaceId: true,
  sessionId: true,
  reservedUploadItemId: true,
  status: true,
  storageCleanupStatus: true,
  storageCleanupLastErrorCode: true,
  storageCleanupAttemptCount: true,
  storageCleanupNotBefore: true,
  intentFinalizeDeadlineAt: true,
  finalizeLeaseUntil: true,
  cleanupLeaseUntil: true,
  cleanupAttemptToken: true,
  stagingOriginalPath: true,
  canonicalOriginalPath: true,
  session: { select: { cleanupLeaseUntil: true } },
} as const;

type CandidateRow = Prisma.UploadIntentGetPayload<{ select: typeof CANDIDATE_SELECT }>;

function toSnapshot(row: CandidateRow, liveUploadItemExists: boolean): IntentSweepSnapshot {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    reservedUploadItemId: row.reservedUploadItemId,
    status: row.status,
    storageCleanupStatus: row.storageCleanupStatus,
    storageCleanupLastErrorCode: row.storageCleanupLastErrorCode,
    storageCleanupAttemptCount: row.storageCleanupAttemptCount,
    storageCleanupNotBefore: row.storageCleanupNotBefore,
    intentFinalizeDeadlineAt: row.intentFinalizeDeadlineAt,
    finalizeLeaseUntil: row.finalizeLeaseUntil,
    cleanupLeaseUntil: row.cleanupLeaseUntil,
    cleanupAttemptToken: row.cleanupAttemptToken,
    sessionCleanupLeaseUntil: row.session.cleanupLeaseUntil,
    stagingOriginalPath: row.stagingOriginalPath,
    canonicalOriginalPath: row.canonicalOriginalPath,
    liveUploadItemExists,
  };
}

export function createPrismaIntentSweepStore(prisma: PrismaClient): IntentSweepStore {
  async function liveItemSet(reservedUploadItemIds: string[]): Promise<Set<string>> {
    if (reservedUploadItemIds.length === 0) return new Set();
    const items = await prisma.uploadItem.findMany({
      where: { id: { in: reservedUploadItemIds } },
      select: { id: true },
    });
    return new Set(items.map((item) => item.id));
  }

  return {
    async listCandidates({ now, take }) {
      const rows = await prisma.uploadIntent.findMany({
        where: {
          storageCleanupNotBefore: { lte: now },
          OR: [
            { storageCleanupStatus: "PENDING" },
            // FAILED は retryable 固定分類のみ（attempt 回数条件は禁止）。
            // terminal / 未知 / null は dead-letter として candidate 外。
            {
              storageCleanupStatus: "FAILED",
              storageCleanupLastErrorCode: { in: [...RETRYABLE_CLEANUP_FAILURE_CODES] },
            },
          ],
        },
        orderBy: { storageCleanupNotBefore: "asc" },
        take,
        select: CANDIDATE_SELECT,
      });
      const live = await liveItemSet(rows.map((row) => row.reservedUploadItemId));
      return rows.map((row) => toSnapshot(row, live.has(row.reservedUploadItemId)));
    },

    async countDeadLetters() {
      const grouped = await prisma.uploadIntent.groupBy({
        by: ["storageCleanupLastErrorCode"],
        where: { storageCleanupStatus: "FAILED" },
        _count: { _all: true },
      });
      let total = 0;
      const byCode: Record<string, number> = {};
      for (const group of grouped) {
        if (classifyCleanupFailureCode(group.storageCleanupLastErrorCode) !== "DEAD_LETTER") continue;
        const code = group.storageCleanupLastErrorCode ?? "UNKNOWN";
        byCode[code] = (byCode[code] ?? 0) + group._count._all;
        total += group._count._all;
      }
      return { total, byCode };
    },

    async claimIntent({
      intentId,
      sessionId,
      workspaceId,
      expectedStatus,
      expectedCleanupStatus,
      expireIntent,
      attemptToken,
      leaseUntil,
      now,
    }) {
      return prisma.$transaction(async (tx) => {
        // lock 順序: UploadSession row → UploadIntent row（deadlock 回避の共通順序）。
        // session guard は row-lock 目的で updatedAt を bump する。
        // UploadSession.updatedAt を eligibility / cutoff / fresh 判定へは使わない。
        const sessionGuard = await tx.uploadSession.updateMany({
          where: {
            id: sessionId,
            workspaceId,
            OR: [{ cleanupLeaseUntil: null }, { cleanupLeaseUntil: { lte: now } }],
          },
          data: { updatedAt: now },
        });
        if (sessionGuard.count === 0) return "session_blocked";

        const claimed = await tx.uploadIntent.updateMany({
          where: {
            id: intentId,
            sessionId,
            workspaceId,
            status: expectedStatus,
            storageCleanupStatus: expectedCleanupStatus,
            storageCleanupNotBefore: { lte: now },
            AND: [
              { OR: [{ cleanupLeaseUntil: null }, { cleanupLeaseUntil: { lte: now } }] },
              { OR: [{ finalizeLeaseUntil: null }, { finalizeLeaseUntil: { lte: now } }] },
            ],
          },
          data: {
            cleanupAttemptToken: attemptToken,
            cleanupLeaseUntil: leaseUntil,
            storageCleanupAttemptCount: { increment: 1 },
            storageCleanupLastErrorCode: null,
            // PREPARED / stale FINALIZING の期限超過は claim と同一 guarded update で
            // EXPIRED へ遷移する（active FINALIZING は classifier / finalize lease 条件が拒否）。
            ...(expireIntent ? { status: "EXPIRED" as const } : {}),
          },
        });
        return claimed.count === 1 ? "claimed" : "conflict";
      });
    },

    async readIntentSnapshot(intentId) {
      const row = await prisma.uploadIntent.findUnique({
        where: { id: intentId },
        select: CANDIDATE_SELECT,
      });
      if (!row) return null;
      const item = await prisma.uploadItem.findUnique({
        where: { id: row.reservedUploadItemId },
        select: { id: true },
      });
      return toSnapshot(row, item !== null);
    },

    async confirmCleanupDone({ intentId, attemptToken, now }) {
      const updated = await prisma.uploadIntent.updateMany({
        where: {
          id: intentId,
          cleanupAttemptToken: attemptToken,
          // DONE は notBefore 以降の削除成功時のみ（canMarkStorageCleanupDone と同条件を DB でも強制）。
          storageCleanupNotBefore: { lte: now },
        },
        data: {
          storageCleanupStatus: "DONE",
          storageCleanedAt: now,
          storageCleanupLastErrorCode: null,
          cleanupLeaseUntil: null,
          cleanupAttemptToken: null,
        },
      });
      return updated.count === 1;
    },

    async recordCleanupFailure({ intentId, attemptToken, errorCode }) {
      const updated = await prisma.uploadIntent.updateMany({
        where: { id: intentId, cleanupAttemptToken: attemptToken },
        data: {
          storageCleanupStatus: "FAILED",
          storageCleanupLastErrorCode: errorCode,
          cleanupLeaseUntil: null,
          cleanupAttemptToken: null,
        },
      });
      return updated.count === 1;
    },

    async releaseIntentClaim({ intentId, attemptToken }) {
      await prisma.uploadIntent.updateMany({
        where: { id: intentId, cleanupAttemptToken: attemptToken },
        data: { cleanupLeaseUntil: null, cleanupAttemptToken: null },
      });
    },
  };
}
