// Cleanup orchestration for abandoned upload sessions.
//
// Phase 10-43-B3c-3: 従来の「収集済み temp path を消してから session を消す」
// legacy core（cleanupUploadsCore）に加えて、claim / stable snapshot / path
// re-derivation / conditional delete を備えた session storage-first cleanup
// runtime（runSessionCleanup）を追加した。cron / manual route は必ず
// runSessionCleanup を使う（legacy core は既存 multipart 非回帰 test の
// 正本としてのみ残す — 新しい呼び出し元を追加しない）。
//
// Invariant（両 core 共通）: session の DB 行は、その session が所有する
// Storage object の削除が全て成功した後にのみ削除する。Storage 削除が
// 失敗したら DB 行を残し、次回 run が missing → 冪等成功で収束させる
// （「DB は消えたが object が孤児」を絶対に作らない）。

import {
  CLEANUP_LEASE_MS,
  isLeaseActive,
  type UploadIntentStatusValue,
} from "../upload/uploadIntentCore";
import { decideClaim, ownsClaim } from "../upload/cleanupClaimCore";
import {
  mergeCleanupPathPlans,
  planIntentCleanupPaths,
  planItemAssetCleanupPaths,
  planItemTempCleanupPaths,
  type CleanupPathPlan,
} from "../upload/cleanupPaths";
import {
  removeStoragePathsInBatches,
  type StorageRemover,
} from "../upload/intentSweepCore";
import type { PrismaClient } from "@/generated/prisma/client";

// ---------------------------------------------------------------------------
// Legacy multipart core（既存契約 — 変更しない）
// ---------------------------------------------------------------------------

export type CleanupSession = {
  id: string;
  status: string;
  /** Temp storage paths of non-committed items in this session. */
  tempPaths: string[];
};

export type CleanupDeps = {
  /** Remove paths from storage. Returns a non-null error string on failure. */
  removeStorage: (paths: string[]) => Promise<{ error: string | null }>;
  /** Physically delete the session (cascades to items). May throw. */
  deleteSession: (id: string) => Promise<void>;
};

export type CleanupResult = {
  scannedSessions: number;
  deletedSessions: number;
  retainedSessions: number;
  deletedStoragePaths: number;
  warnings: string[];
};

export async function cleanupUploadsCore(
  sessions: CleanupSession[],
  deps: CleanupDeps,
): Promise<CleanupResult> {
  const result: CleanupResult = {
    scannedSessions: sessions.length,
    deletedSessions: 0,
    retainedSessions: 0,
    deletedStoragePaths: 0,
    warnings: [],
  };

  for (const session of sessions) {
    // Sessions with no temp files are safe to delete directly.
    if (session.tempPaths.length > 0) {
      const { error } = await deps.removeStorage(session.tempPaths);
      if (error) {
        // Storage removal failed — keep the DB record for a later retry.
        result.retainedSessions++;
        result.warnings.push(`session ${session.id}: storage remove failed (${error}); DB retained`);
        continue;
      }
      result.deletedStoragePaths += session.tempPaths.length;
    }

    try {
      await deps.deleteSession(session.id);
      result.deletedSessions++;
    } catch (e) {
      result.retainedSessions++;
      result.warnings.push(
        `session ${session.id}: DB delete failed (${e instanceof Error ? e.message : String(e)})`,
      );
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Phase 10-43-B3c-3: session storage-first cleanup runtime
// ---------------------------------------------------------------------------

// 承認済み runtime 定数。lease は既存正本 CLEANUP_LEASE_MS(5 分) を再利用する。
export const SESSION_CLEANUP_BATCH_SIZE = 25;
// fresh 判定の grace。UploadItem.updatedAt（UPLOADING）/ commitStartedAt
// （IN_PROGRESS）が「now - grace より後」の行を in-flight とみなして skip する。
// 境界（== now - grace）は stale = cleanup 候補可。
// UploadSession.updatedAt は fresh 判定へ使用しない（claim guard が bump するため）。
export const IN_FLIGHT_GRACE_MS = 60 * 60 * 1000;

export type SessionCleanupItemRow = {
  id: string;
  uploadStatus: string;
  updatedAt: Date;
  commitStatus: string;
  commitStartedAt: Date | null;
  committedImageId: string | null;
  originalExt: string;
  tempStoragePath: string;
  tempThumbnailPath: string | null;
  tempPreviewPath: string | null;
  reservedImageId: string | null;
  assetStoragePath: string | null;
  assetThumbnailPath: string | null;
  assetPreviewPath: string | null;
  /** reservedImageId に対応する正式 Image 行が存在するか（呼び出し側で照会済み）。 */
  imageRowExists: boolean;
};

export type SessionCleanupIntentRow = {
  id: string;
  status: UploadIntentStatusValue;
  storageCleanupNotBefore: Date;
  finalizeLeaseUntil: Date | null;
  cleanupLeaseUntil: Date | null;
  reservedUploadItemId: string;
  stagingOriginalPath: string;
  canonicalOriginalPath: string | null;
};

export type SessionCleanupCandidate = {
  id: string;
  workspaceId: string;
  status: string;
  createdAt: Date;
  cleanupLeaseUntil: Date | null;
  items: SessionCleanupItemRow[];
  intents: SessionCleanupIntentRow[];
};

export type SessionCleanupSnapshot = SessionCleanupCandidate & {
  cleanupAttemptToken: string | null;
};

export type SessionUnsafeReason =
  | "COMMITTED_SESSION"
  | "COMMITTED_ITEM"
  | "FRESH_UPLOADING"
  | "FRESH_IN_PROGRESS"
  | "FUTURE_NOT_BEFORE"
  | "FINALIZE_IN_PROGRESS"
  | "INTENT_CLEANUP_IN_PROGRESS";

export type SessionClaimOutcome =
  | { kind: "claimed" }
  | { kind: "conflict" }
  | { kind: "unsafe"; reason: SessionUnsafeReason };

export type SessionCleanupStore = {
  /** candidate 取得（COMMITTED 以外・createdAt < cutoff・batch 上限・scope 任意）。 */
  listCandidates(args: {
    cutoff: Date;
    take: number;
    scope?: { workspaceId: string; userId: string };
  }): Promise<SessionCleanupCandidate[]>;
  /**
   * 短い transaction 内で: 条件付き claim → 同一 tx 内で items / intents を
   * 再読込 → unsafe が 1 件でもあれば sentinel throw で全体 rollback。
   * safe な場合だけ claim を commit する。
   */
  claimSession(args: {
    sessionId: string;
    attemptToken: string;
    leaseUntil: Date;
    now: Date;
    freshCutoff: Date;
  }): Promise<SessionClaimOutcome>;
  /** claim 後の stable snapshot 再読込（Image 行の存在照会を含む）。 */
  readSessionSnapshot(sessionId: string): Promise<SessionCleanupSnapshot | null>;
  /** token 所有権条件付きの claim 解放。 */
  releaseSessionClaim(args: { sessionId: string; attemptToken: string }): Promise<void>;
  /**
   * token 一致 + 安全条件（非 COMMITTED・fresh marker なし・COMMITTED item なし・
   * future notBefore なし・active finalize / intent claim なし）を同一 atomic
   * delete 条件で再確認する deleteMany。戻り値は削除行数（0 = 強制削除しない）。
   */
  deleteSessionGuarded(args: {
    sessionId: string;
    attemptToken: string;
    now: Date;
    freshCutoff: Date;
  }): Promise<number>;
};

// ---------------------------------------------------------------------------
// Pure 判定 / path plan（unit test の正本）
// ---------------------------------------------------------------------------

function isFreshUploading(item: SessionCleanupItemRow, freshCutoff: Date): boolean {
  // 境界: updatedAt == freshCutoff は stale（> のみ fresh）。
  return item.uploadStatus === "UPLOADING" && item.updatedAt.getTime() > freshCutoff.getTime();
}

function isFreshInProgress(item: SessionCleanupItemRow, freshCutoff: Date): boolean {
  return (
    item.commitStatus === "IN_PROGRESS" &&
    item.commitStartedAt !== null &&
    item.commitStartedAt.getTime() > freshCutoff.getTime()
  );
}

/**
 * session cleanup の unsafe 判定（session cleanup claim 自体の lease は含まない —
 * claim 競合は呼び出し側が isLeaseActive / claim outcome で扱う）。
 */
export function classifySessionCleanupUnsafe(
  candidate: Pick<SessionCleanupCandidate, "status" | "items" | "intents">,
  now: Date,
  freshCutoff: Date,
): SessionUnsafeReason | null {
  if (candidate.status === "COMMITTED") return "COMMITTED_SESSION";
  for (const item of candidate.items) {
    if (item.commitStatus === "COMMITTED" || item.committedImageId !== null) return "COMMITTED_ITEM";
  }
  for (const item of candidate.items) {
    if (isFreshUploading(item, freshCutoff)) return "FRESH_UPLOADING";
  }
  for (const item of candidate.items) {
    if (isFreshInProgress(item, freshCutoff)) return "FRESH_IN_PROGRESS";
  }
  for (const intent of candidate.intents) {
    if (intent.storageCleanupNotBefore.getTime() > now.getTime()) return "FUTURE_NOT_BEFORE";
  }
  for (const intent of candidate.intents) {
    if (isLeaseActive(intent.finalizeLeaseUntil, now)) return "FINALIZE_IN_PROGRESS";
  }
  for (const intent of candidate.intents) {
    if (isLeaseActive(intent.cleanupLeaseUntil, now)) return "INTENT_CLEANUP_IN_PROGRESS";
  }
  return null;
}

/**
 * session が所有する全 Storage object の削除 path 計画。
 * - UploadItem temp = planItemTempCleanupPaths（既存 multipart 契約）
 * - uncommitted commit orphan asset = planItemAssetCleanupPaths（正式 Image 行 /
 *   committedImageId を持つ asset は絶対に含めない・null path は候補に入れない）
 * - intent 所有 = planIntentCleanupPaths（live item がある canonical / variants は
 *   intent 側から除外され、item temp 側で回収される）
 * 1 件でも失敗 plan があれば全体 fail-closed（Storage remove 0 / delete 0）。
 * path は挿入順で dedup される。
 */
export function planSessionCleanupPaths(
  snapshot: Pick<SessionCleanupCandidate, "id" | "workspaceId" | "items" | "intents">,
): CleanupPathPlan {
  const liveItemIds = new Set(snapshot.items.map((item) => item.id));
  const plans: CleanupPathPlan[] = [];

  for (const item of snapshot.items) {
    plans.push(
      planItemTempCleanupPaths({
        workspaceId: snapshot.workspaceId,
        sessionId: snapshot.id,
        uploadItemId: item.id,
        originalExt: item.originalExt,
        tempStoragePath: item.tempStoragePath,
        tempThumbnailPath: item.tempThumbnailPath,
        tempPreviewPath: item.tempPreviewPath,
      }),
    );
    plans.push(
      planItemAssetCleanupPaths({
        workspaceId: snapshot.workspaceId,
        reservedImageId: item.reservedImageId,
        originalExt: item.originalExt,
        tempThumbnailPath: item.tempThumbnailPath,
        tempPreviewPath: item.tempPreviewPath,
        assetStoragePath: item.assetStoragePath,
        assetThumbnailPath: item.assetThumbnailPath,
        assetPreviewPath: item.assetPreviewPath,
        committedImageId: item.committedImageId,
        imageRowExists: item.imageRowExists,
      }),
    );
  }

  for (const intent of snapshot.intents) {
    plans.push(
      planIntentCleanupPaths({
        workspaceId: snapshot.workspaceId,
        sessionId: snapshot.id,
        intentId: intent.id,
        reservedUploadItemId: intent.reservedUploadItemId,
        stagingOriginalPath: intent.stagingOriginalPath,
        canonicalOriginalPath: intent.canonicalOriginalPath,
        liveUploadItemExists: liveItemIds.has(intent.reservedUploadItemId),
      }),
    );
  }

  return mergeCleanupPathPlans(plans);
}

// ---------------------------------------------------------------------------
// runSessionCleanup（cron / manual 共通の唯一の実行経路）
// ---------------------------------------------------------------------------

export type SessionCleanupRunArgs = {
  store: SessionCleanupStore;
  removeStorage: StorageRemover;
  now: () => Date;
  generateAttemptToken: () => string;
  cutoff: Date;
  dryRun: boolean;
  /** SESSION_CLEANUP_BATCH_SIZE を超える値は clamp される。 */
  maxSessions?: number;
  /** manual route 用の workspace / user scope。cron は未指定（全 workspace）。 */
  scope?: { workspaceId: string; userId: string };
};

export type SessionCleanupRunResult = {
  considered: number;
  claimed: number;
  deleted: number;
  retained: number;
  skippedCommittedSession: number;
  skippedCommittedItem: number;
  skippedFreshUploading: number;
  skippedFreshCommit: number;
  skippedFutureNotBefore: number;
  skippedFinalizeInProgress: number;
  skippedIntentCleanupInProgress: number;
  skippedClaimConflict: number;
  pathFailures: number;
  storageDeleted: number;
  storageMissing: number;
  storageFailed: number;
  plannedStoragePaths: number;
  itemsConsidered: number;
  /** manual route の response 互換（COMMITTED item を除く件数）。 */
  sessions: Array<{ id: string; status: string; createdAt: Date; itemCount: number }>;
  // 固定分類 + id のみ（raw path / provider message / token を含めない）。
  warnings: string[];
};

function bumpUnsafeMetric(result: SessionCleanupRunResult, reason: SessionUnsafeReason): void {
  switch (reason) {
    case "COMMITTED_SESSION":
      result.skippedCommittedSession += 1;
      return;
    case "COMMITTED_ITEM":
      result.skippedCommittedItem += 1;
      return;
    case "FRESH_UPLOADING":
      result.skippedFreshUploading += 1;
      return;
    case "FRESH_IN_PROGRESS":
      result.skippedFreshCommit += 1;
      return;
    case "FUTURE_NOT_BEFORE":
      result.skippedFutureNotBefore += 1;
      return;
    case "FINALIZE_IN_PROGRESS":
      result.skippedFinalizeInProgress += 1;
      return;
    case "INTENT_CLEANUP_IN_PROGRESS":
      result.skippedIntentCleanupInProgress += 1;
      return;
  }
}

/**
 * 正式順序（B3c-3 承認済み）:
 *   candidate 取得 → claim → claim 後 snapshot 再読込 → path plan（全件）→
 *   （1 件でも path failure なら Storage 0）→ dedup → Storage 全削除 →
 *   missing 冪等成功 → 全削除成功後だけ token 条件付き session delete。
 * DB delete を Storage remove より前へ移動しない。
 * candidate ごとに失敗を分離する（1 件の失敗で run を落とさない）。
 */
export async function runSessionCleanup(args: SessionCleanupRunArgs): Promise<SessionCleanupRunResult> {
  const take = Math.max(1, Math.min(args.maxSessions ?? SESSION_CLEANUP_BATCH_SIZE, SESSION_CLEANUP_BATCH_SIZE));

  const result: SessionCleanupRunResult = {
    considered: 0,
    claimed: 0,
    deleted: 0,
    retained: 0,
    skippedCommittedSession: 0,
    skippedCommittedItem: 0,
    skippedFreshUploading: 0,
    skippedFreshCommit: 0,
    skippedFutureNotBefore: 0,
    skippedFinalizeInProgress: 0,
    skippedIntentCleanupInProgress: 0,
    skippedClaimConflict: 0,
    pathFailures: 0,
    storageDeleted: 0,
    storageMissing: 0,
    storageFailed: 0,
    plannedStoragePaths: 0,
    itemsConsidered: 0,
    sessions: [],
    warnings: [],
  };

  const candidates = await args.store.listCandidates({ cutoff: args.cutoff, take, scope: args.scope });
  result.considered = candidates.length;

  for (const candidate of candidates) {
    let claimedToken: string | null = null;
    try {
      const now = args.now();
      const freshCutoff = new Date(now.getTime() - IN_FLIGHT_GRACE_MS);

      const nonCommittedItemCount = candidate.items.filter(
        (item) => item.commitStatus !== "COMMITTED" && item.committedImageId === null,
      ).length;
      result.itemsConsidered += nonCommittedItemCount;
      result.sessions.push({
        id: candidate.id,
        status: candidate.status,
        createdAt: candidate.createdAt,
        itemCount: nonCommittedItemCount,
      });

      // --- 1. claim 前分類 ---------------------------------------------------
      if (isLeaseActive(candidate.cleanupLeaseUntil, now)) {
        result.skippedClaimConflict += 1;
        continue;
      }
      const unsafeBefore = classifySessionCleanupUnsafe(candidate, now, freshCutoff);
      if (unsafeBefore !== null) {
        bumpUnsafeMetric(result, unsafeBefore);
        continue;
      }

      // 削除予定 path 数（pure 再計算のみ — dryRun / manual response 用の観測値）。
      const previewPlan = planSessionCleanupPaths(candidate);
      if (previewPlan.ok) {
        result.plannedStoragePaths += previewPlan.entries.length;
      }

      if (args.dryRun) {
        // dryRun: claim 0 / Storage remove 0 / DB update・delete 0。
        continue;
      }

      // --- 2. claim（短 tx + 同 tx 内 unsafe 再読込 + sentinel rollback） ----
      const attemptToken = args.generateAttemptToken();
      const claimDecision = decideClaim({
        now,
        state: { cleanupLeaseUntil: candidate.cleanupLeaseUntil, cleanupAttemptToken: null },
        attemptToken,
        leaseMs: CLEANUP_LEASE_MS,
      });
      if (!claimDecision.ok) {
        result.skippedClaimConflict += 1;
        continue;
      }
      const claimOutcome = await args.store.claimSession({
        sessionId: candidate.id,
        attemptToken,
        leaseUntil: claimDecision.leaseUntil,
        now,
        freshCutoff,
      });
      if (claimOutcome.kind === "conflict") {
        result.skippedClaimConflict += 1;
        continue;
      }
      if (claimOutcome.kind === "unsafe") {
        bumpUnsafeMetric(result, claimOutcome.reason);
        continue;
      }
      claimedToken = attemptToken;
      result.claimed += 1;

      // --- 3. claim 後の stable snapshot 再読込 ------------------------------
      // claim 成功後は B3c-2 interlock により新 item / 新 PUT / 新 IN_PROGRESS /
      // 新 asset copy / 新 prepare / finalize / 新 intent claim が開始されない。
      // claim 前 snapshot を Storage 削除に使わない。
      const snapshot = await args.store.readSessionSnapshot(candidate.id);
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
        claimedToken = null;
        result.retained += 1;
        result.warnings.push(`session ${candidate.id}: cleanup claim lost after acquisition; DB retained`);
        continue;
      }

      const postNow = args.now();
      const postFreshCutoff = new Date(postNow.getTime() - IN_FLIGHT_GRACE_MS);
      const unsafeAfter = classifySessionCleanupUnsafe(snapshot, postNow, postFreshCutoff);
      if (unsafeAfter !== null) {
        await args.store.releaseSessionClaim({ sessionId: candidate.id, attemptToken });
        claimedToken = null;
        bumpUnsafeMetric(result, unsafeAfter);
        continue;
      }

      // --- 4. path plan（fail-closed） ---------------------------------------
      const plan = planSessionCleanupPaths(snapshot);
      if (!plan.ok) {
        await args.store.releaseSessionClaim({ sessionId: candidate.id, attemptToken });
        claimedToken = null;
        result.pathFailures += 1;
        result.retained += 1;
        result.warnings.push(
          `session ${candidate.id}: cleanup path plan failed (${plan.reason}); storage remove 0; DB retained`,
        );
        continue;
      }

      // --- 5. Storage 全削除（missing 冪等成功・部分失敗は DB 残置） ---------
      const removeResult = await removeStoragePathsInBatches(
        args.removeStorage,
        plan.entries.map((entry) => entry.path),
      );
      result.storageDeleted += removeResult.deleted;
      result.storageMissing += removeResult.missing;

      if (!removeResult.ok) {
        result.storageFailed += 1;
        await args.store.releaseSessionClaim({ sessionId: candidate.id, attemptToken });
        claimedToken = null;
        result.retained += 1;
        result.warnings.push(
          `session ${candidate.id}: storage remove failed (${removeResult.errorCode}); DB retained`,
        );
        continue;
      }

      // --- 6. token 条件付き final delete（安全条件を atomic に再確認） ------
      const deleteNow = args.now();
      const deleteFreshCutoff = new Date(deleteNow.getTime() - IN_FLIGHT_GRACE_MS);
      const deletedCount = await args.store.deleteSessionGuarded({
        sessionId: candidate.id,
        attemptToken,
        now: deleteNow,
        freshCutoff: deleteFreshCutoff,
      });
      claimedToken = null;
      if (deletedCount === 0) {
        // snapshot 後に状態が変わった — DB を強制変更せず claim を解放して終了。
        await args.store
          .releaseSessionClaim({ sessionId: candidate.id, attemptToken })
          .catch(() => undefined);
        result.retained += 1;
        result.warnings.push(
          `session ${candidate.id}: final delete guarded out (state changed after snapshot); DB retained`,
        );
        continue;
      }
      result.deleted += 1;
    } catch {
      result.warnings.push(`session ${candidate.id}: cleanup failed (UNEXPECTED); DB retained`);
      result.retained += 1;
      if (claimedToken !== null) {
        await args.store
          .releaseSessionClaim({ sessionId: candidate.id, attemptToken: claimedToken })
          .catch(() => undefined);
        claimedToken = null;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Prisma-backed store（cron / manual route から使う唯一の実装）
// ---------------------------------------------------------------------------

const SESSION_ITEM_SELECT = {
  id: true,
  uploadStatus: true,
  updatedAt: true,
  commitStatus: true,
  commitStartedAt: true,
  committedImageId: true,
  originalExt: true,
  tempStoragePath: true,
  tempThumbnailPath: true,
  tempPreviewPath: true,
  reservedImageId: true,
  assetStoragePath: true,
  assetThumbnailPath: true,
  assetPreviewPath: true,
} as const;

const SESSION_INTENT_SELECT = {
  id: true,
  status: true,
  storageCleanupNotBefore: true,
  finalizeLeaseUntil: true,
  cleanupLeaseUntil: true,
  reservedUploadItemId: true,
  stagingOriginalPath: true,
  canonicalOriginalPath: true,
} as const;

// claim tx の unsafe 検出を rollback として伝える store-private sentinel。
class SessionCleanupUnsafeError extends Error {
  constructor(public readonly reason: SessionUnsafeReason) {
    super("session cleanup unsafe");
    this.name = "SessionCleanupUnsafeError";
  }
}

// 削除候補になり得る session status（COMMITTED は決して含めない）。
const CANDIDATE_SESSION_STATUSES = ["ACTIVE", "PREVIEWING", "ABANDONED"] as const;

export function createPrismaSessionCleanupStore(prisma: PrismaClient): SessionCleanupStore {
  async function attachImageExistence(
    sessions: Array<{
      id: string;
      workspaceId: string;
      status: string;
      createdAt: Date;
      cleanupLeaseUntil: Date | null;
      cleanupAttemptToken?: string | null;
      items: Array<Omit<SessionCleanupItemRow, "imageRowExists">>;
      uploadIntents: SessionCleanupIntentRow[];
    }>,
  ): Promise<SessionCleanupSnapshot[]> {
    const reservedImageIds = [
      ...new Set(
        sessions.flatMap((session) =>
          session.items
            .map((item) => item.reservedImageId)
            .filter((id): id is string => id !== null),
        ),
      ),
    ];
    const images =
      reservedImageIds.length > 0
        ? await prisma.image.findMany({ where: { id: { in: reservedImageIds } }, select: { id: true } })
        : [];
    const imageIdSet = new Set(images.map((image) => image.id));

    return sessions.map((session) => ({
      id: session.id,
      workspaceId: session.workspaceId,
      status: session.status,
      createdAt: session.createdAt,
      cleanupLeaseUntil: session.cleanupLeaseUntil,
      cleanupAttemptToken: session.cleanupAttemptToken ?? null,
      items: session.items.map((item) => ({
        ...item,
        imageRowExists: item.reservedImageId !== null && imageIdSet.has(item.reservedImageId),
      })),
      intents: session.uploadIntents,
    }));
  }

  return {
    async listCandidates({ cutoff, take, scope }) {
      const rows = await prisma.uploadSession.findMany({
        where: {
          status: { in: [...CANDIDATE_SESSION_STATUSES] },
          createdAt: { lt: cutoff },
          ...(scope ? { workspaceId: scope.workspaceId, userId: scope.userId } : {}),
        },
        take,
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          workspaceId: true,
          status: true,
          createdAt: true,
          cleanupLeaseUntil: true,
          items: { select: SESSION_ITEM_SELECT },
          uploadIntents: { select: SESSION_INTENT_SELECT },
        },
      });
      return attachImageExistence(rows);
    },

    async claimSession({ sessionId, attemptToken, leaseUntil, now, freshCutoff }) {
      try {
        return await prisma.$transaction(async (tx) => {
          // lock 順序: UploadSession row → (再読込) UploadIntent / UploadItem。
          const claimed = await tx.uploadSession.updateMany({
            where: {
              id: sessionId,
              status: { not: "COMMITTED" },
              OR: [{ cleanupLeaseUntil: null }, { cleanupLeaseUntil: { lte: now } }],
            },
            data: { cleanupLeaseUntil: leaseUntil, cleanupAttemptToken: attemptToken },
          });
          if (claimed.count === 0) return { kind: "conflict" as const };

          // 同一 tx 内の再読込。unsafe が 1 件でもあれば sentinel throw で
          // transaction 全体（claim を含む）を rollback する。
          const session = await tx.uploadSession.findUnique({
            where: { id: sessionId },
            select: { status: true },
          });
          if (!session || session.status === "COMMITTED") {
            throw new SessionCleanupUnsafeError("COMMITTED_SESSION");
          }
          const committedItems = await tx.uploadItem.count({
            where: {
              sessionId,
              OR: [{ commitStatus: "COMMITTED" }, { committedImageId: { not: null } }],
            },
          });
          if (committedItems > 0) throw new SessionCleanupUnsafeError("COMMITTED_ITEM");
          const freshUploading = await tx.uploadItem.count({
            where: { sessionId, uploadStatus: "UPLOADING", updatedAt: { gt: freshCutoff } },
          });
          if (freshUploading > 0) throw new SessionCleanupUnsafeError("FRESH_UPLOADING");
          const freshInProgress = await tx.uploadItem.count({
            where: { sessionId, commitStatus: "IN_PROGRESS", commitStartedAt: { gt: freshCutoff } },
          });
          if (freshInProgress > 0) throw new SessionCleanupUnsafeError("FRESH_IN_PROGRESS");
          const futureNotBefore = await tx.uploadIntent.count({
            where: { sessionId, storageCleanupNotBefore: { gt: now } },
          });
          if (futureNotBefore > 0) throw new SessionCleanupUnsafeError("FUTURE_NOT_BEFORE");
          const activeFinalize = await tx.uploadIntent.count({
            where: { sessionId, finalizeLeaseUntil: { gt: now } },
          });
          if (activeFinalize > 0) throw new SessionCleanupUnsafeError("FINALIZE_IN_PROGRESS");
          const activeIntentCleanup = await tx.uploadIntent.count({
            where: { sessionId, cleanupLeaseUntil: { gt: now } },
          });
          if (activeIntentCleanup > 0) throw new SessionCleanupUnsafeError("INTENT_CLEANUP_IN_PROGRESS");

          return { kind: "claimed" as const };
        });
      } catch (e) {
        if (e instanceof SessionCleanupUnsafeError) {
          return { kind: "unsafe", reason: e.reason };
        }
        throw e;
      }
    },

    async readSessionSnapshot(sessionId) {
      const row = await prisma.uploadSession.findUnique({
        where: { id: sessionId },
        select: {
          id: true,
          workspaceId: true,
          status: true,
          createdAt: true,
          cleanupLeaseUntil: true,
          cleanupAttemptToken: true,
          items: { select: SESSION_ITEM_SELECT },
          uploadIntents: { select: SESSION_INTENT_SELECT },
        },
      });
      if (!row) return null;
      const [snapshot] = await attachImageExistence([row]);
      return snapshot;
    },

    async releaseSessionClaim({ sessionId, attemptToken }) {
      await prisma.uploadSession.updateMany({
        where: { id: sessionId, cleanupAttemptToken: attemptToken },
        data: { cleanupLeaseUntil: null, cleanupAttemptToken: null },
      });
    },

    async deleteSessionGuarded({ sessionId, attemptToken, now, freshCutoff }) {
      const deleted = await prisma.uploadSession.deleteMany({
        where: {
          id: sessionId,
          status: { not: "COMMITTED" },
          cleanupAttemptToken: attemptToken,
          items: {
            none: {
              OR: [
                { commitStatus: "COMMITTED" },
                { committedImageId: { not: null } },
                { uploadStatus: "UPLOADING", updatedAt: { gt: freshCutoff } },
                { commitStatus: "IN_PROGRESS", commitStartedAt: { gt: freshCutoff } },
              ],
            },
          },
          uploadIntents: {
            none: {
              OR: [
                { storageCleanupNotBefore: { gt: now } },
                { finalizeLeaseUntil: { gt: now } },
                { cleanupLeaseUntil: { gt: now } },
              ],
            },
          },
        },
      });
      return deleted.count;
    },
  };
}
