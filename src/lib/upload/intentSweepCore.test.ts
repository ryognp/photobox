// Phase 10-43-B3c-3: intentSweepCore の unit test。
// DB / Storage は in-memory fake を注入する（実 Prisma / 実 Supabase なし）。
// prisma-backed store の条件付き update / lock 順序の実 DB 証明は
// src/app/api/cron/cleanup-uploads/route.integration.test.ts が担う。

import { describe, it, expect } from "vitest";
import {
  INTENT_SWEEP_BATCH_SIZE,
  STORAGE_REMOVE_BATCH_SIZE,
  removeStoragePathsInBatches,
  runIntentSweep,
  type IntentClaimOutcome,
  type IntentSweepCandidate,
  type IntentSweepSnapshot,
  type IntentSweepStore,
  type StorageRemover,
  type StorageRemoveResponse,
} from "@/lib/upload/intentSweepCore";
import { RETRYABLE_CLEANUP_FAILURE_CODES } from "@/lib/upload/intentCleanupLifecycle";
import {
  intentStagingOriginalPath,
  tempOriginalPath,
  tempPreviewPath,
  tempThumbnailPath,
} from "@/lib/upload/storagePaths";

const NOW = new Date("2026-08-12T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const W = "w1";
const S = "sess1";

const RETRYABLE_SET: ReadonlySet<string> = new Set(RETRYABLE_CLEANUP_FAILURE_CODES);

function makeCandidate(overrides: Partial<IntentSweepCandidate> = {}): IntentSweepCandidate {
  const id = overrides.id ?? "intent1";
  const reserved = overrides.reservedUploadItemId ?? "resv1";
  return {
    id,
    workspaceId: W,
    sessionId: S,
    reservedUploadItemId: reserved,
    status: "FINALIZED",
    storageCleanupStatus: "PENDING",
    storageCleanupLastErrorCode: null,
    storageCleanupAttemptCount: 0,
    storageCleanupNotBefore: new Date(NOW.getTime() - HOUR),
    intentFinalizeDeadlineAt: new Date(NOW.getTime() - 2 * HOUR),
    finalizeLeaseUntil: null,
    cleanupLeaseUntil: null,
    sessionCleanupLeaseUntil: null,
    stagingOriginalPath: intentStagingOriginalPath(W, S, id),
    canonicalOriginalPath: null,
    liveUploadItemExists: false,
    ...overrides,
  };
}

type FakeOpts = {
  deadLetters?: { total: number; byCode: Record<string, number> };
  claimOverride?: (args: { intentId: string }) => IntentClaimOutcome | undefined;
  claimThrows?: Set<string>;
  snapshotOverride?: (id: string) => IntentSweepSnapshot | null | undefined;
  confirmDoneThrowsOnce?: boolean;
};

function createFakeStore(initial: IntentSweepCandidate[], opts: FakeOpts = {}) {
  const state = new Map<string, IntentSweepSnapshot>(
    initial.map((c) => [c.id, { ...c, cleanupAttemptToken: null }]),
  );
  const calls = {
    listTakes: [] as number[],
    claims: [] as string[],
    confirms: [] as string[],
    failures: [] as Array<{ intentId: string; errorCode: string }>,
    releases: [] as string[],
  };
  let confirmDoneThrowsOnce = opts.confirmDoneThrowsOnce ?? false;

  const store: IntentSweepStore = {
    async listCandidates({ take }) {
      calls.listTakes.push(take);
      // fake は candidate query 済み rows を test が直接投入する前提で、
      // DONE / dead-letter の除外だけ実 query 契約に合わせて適用する。
      return [...state.values()]
        .filter(
          (row) =>
            row.storageCleanupStatus === "PENDING" ||
            (row.storageCleanupStatus === "FAILED" &&
              row.storageCleanupLastErrorCode !== null &&
              RETRYABLE_SET.has(row.storageCleanupLastErrorCode)),
        )
        .slice(0, take)
        .map((row) => ({ ...row }));
    },

    async countDeadLetters() {
      return opts.deadLetters ?? { total: 0, byCode: {} };
    },

    async claimIntent(args) {
      calls.claims.push(args.intentId);
      if (opts.claimThrows?.has(args.intentId)) throw new Error("forced claim failure (test)");
      const override = opts.claimOverride?.(args);
      if (override !== undefined) return override;
      const row = state.get(args.intentId);
      if (!row) return "conflict";
      if (row.status !== args.expectedStatus) return "conflict";
      if (row.storageCleanupStatus !== args.expectedCleanupStatus) return "conflict";
      if (row.storageCleanupNotBefore.getTime() > args.now.getTime()) return "conflict";
      if (row.cleanupLeaseUntil !== null && row.cleanupLeaseUntil.getTime() > args.now.getTime()) {
        return "conflict";
      }
      if (row.finalizeLeaseUntil !== null && row.finalizeLeaseUntil.getTime() > args.now.getTime()) {
        return "conflict";
      }
      row.cleanupAttemptToken = args.attemptToken;
      row.cleanupLeaseUntil = args.leaseUntil;
      row.storageCleanupAttemptCount += 1;
      row.storageCleanupLastErrorCode = null;
      if (args.expireIntent) row.status = "EXPIRED";
      return "claimed";
    },

    async readIntentSnapshot(intentId) {
      const override = opts.snapshotOverride?.(intentId);
      if (override !== undefined) return override;
      const row = state.get(intentId);
      return row ? { ...row } : null;
    },

    async confirmCleanupDone({ intentId, attemptToken, now }) {
      if (confirmDoneThrowsOnce) {
        confirmDoneThrowsOnce = false;
        throw new Error("forced DONE write failure (test)");
      }
      calls.confirms.push(intentId);
      const row = state.get(intentId);
      if (!row || row.cleanupAttemptToken !== attemptToken) return false;
      if (row.storageCleanupNotBefore.getTime() > now.getTime()) return false;
      row.storageCleanupStatus = "DONE";
      row.storageCleanupLastErrorCode = null;
      row.cleanupLeaseUntil = null;
      row.cleanupAttemptToken = null;
      return true;
    },

    async recordCleanupFailure({ intentId, attemptToken, errorCode }) {
      calls.failures.push({ intentId, errorCode });
      const row = state.get(intentId);
      if (!row || row.cleanupAttemptToken !== attemptToken) return false;
      row.storageCleanupStatus = "FAILED";
      row.storageCleanupLastErrorCode = errorCode;
      row.cleanupLeaseUntil = null;
      row.cleanupAttemptToken = null;
      return true;
    },

    async releaseIntentClaim({ intentId, attemptToken }) {
      calls.releases.push(intentId);
      const row = state.get(intentId);
      if (!row || row.cleanupAttemptToken !== attemptToken) return;
      row.cleanupLeaseUntil = null;
      row.cleanupAttemptToken = null;
    },
  };

  return { store, state, calls };
}

function makeRemover(
  behavior?: (paths: readonly string[], callIndex: number) => StorageRemoveResponse,
) {
  const calls: string[][] = [];
  const remover: StorageRemover = async (paths) => {
    const index = calls.length;
    calls.push([...paths]);
    return behavior ? behavior(paths, index) : { error: null, removedPaths: [...paths] };
  };
  return { remover, calls };
}

function makeDeps(store: IntentSweepStore, remover: StorageRemover) {
  let tokenIndex = 0;
  return {
    store,
    removeStorage: remover,
    now: () => new Date(NOW),
    generateAttemptToken: () => `token-${++tokenIndex}`,
  };
}

describe("intentSweepCore — runtime constants", () => {
  it("1) batch 上限は 100（既存正本 CLEANUP_BATCH_SIZE を再利用）で、超過指定は clamp される", async () => {
    expect(INTENT_SWEEP_BATCH_SIZE).toBe(100);
    expect(STORAGE_REMOVE_BATCH_SIZE).toBe(100);

    const { store, calls } = createFakeStore([makeCandidate()]);
    const { remover } = makeRemover();
    await runIntentSweep(makeDeps(store, remover), { batchSize: 500 });
    expect(calls.listTakes).toEqual([100]);

    await runIntentSweep(makeDeps(store, remover));
    expect(calls.listTakes[1]).toBe(100);
  });
});

describe("intentSweepCore — eligibility", () => {
  it("2) not-before 前の intent は claim しない（BEFORE_NOT_BEFORE skip）", async () => {
    const { store, calls } = createFakeStore([
      makeCandidate({ storageCleanupNotBefore: new Date(NOW.getTime() + 1) }),
    ]);
    const { remover, calls: removeCalls } = makeRemover();
    const result = await runIntentSweep(makeDeps(store, remover));
    expect(result.skipped).toBe(1);
    expect(result.claimed).toBe(0);
    expect(calls.claims).toHaveLength(0);
    expect(removeCalls).toHaveLength(0);
  });

  it("3) not-before ちょうど（== now）は対象になり DONE まで進む", async () => {
    const { store, state } = createFakeStore([
      makeCandidate({ storageCleanupNotBefore: new Date(NOW.getTime()) }),
    ]);
    const { remover } = makeRemover();
    const result = await runIntentSweep(makeDeps(store, remover));
    expect(result.cleaned).toBe(1);
    expect(state.get("intent1")!.storageCleanupStatus).toBe("DONE");
  });

  it("4) PENDING の期限切れ intent は cleanup され DONE + lease/token clear になる", async () => {
    const { store, state } = createFakeStore([makeCandidate()]);
    const { remover, calls: removeCalls } = makeRemover();
    const result = await runIntentSweep(makeDeps(store, remover));

    expect(result).toMatchObject({ candidates: 1, claimed: 1, cleaned: 1, skipped: 0 });
    const row = state.get("intent1")!;
    expect(row.storageCleanupStatus).toBe("DONE");
    expect(row.storageCleanupLastErrorCode).toBeNull();
    expect(row.cleanupLeaseUntil).toBeNull();
    expect(row.cleanupAttemptToken).toBeNull();
    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0]).toEqual([intentStagingOriginalPath(W, S, "intent1")]);
  });

  it("5) FAILED + retryable 固定分類は再試行対象（DONE へ収束）", async () => {
    const { store, state } = createFakeStore([
      makeCandidate({ storageCleanupStatus: "FAILED", storageCleanupLastErrorCode: "STORAGE_RATE_LIMITED" }),
    ]);
    const { remover } = makeRemover();
    const result = await runIntentSweep(makeDeps(store, remover));
    expect(result.cleaned).toBe(1);
    expect(state.get("intent1")!.storageCleanupStatus).toBe("DONE");
  });

  it("6) attemptCount 0 / 9 / 10 / 100 / MAX_SAFE_INTEGER で retry 挙動が同一（回数 gate なし）", async () => {
    for (const attemptCount of [0, 9, 10, 100, Number.MAX_SAFE_INTEGER - 1]) {
      const { store, state } = createFakeStore([
        makeCandidate({
          storageCleanupStatus: "FAILED",
          storageCleanupLastErrorCode: "STORAGE_UNKNOWN",
          storageCleanupAttemptCount: attemptCount,
        }),
      ]);
      const { remover } = makeRemover();
      const result = await runIntentSweep(makeDeps(store, remover));
      expect(result.cleaned, `attemptCount=${attemptCount}`).toBe(1);
      expect(state.get("intent1")!.storageCleanupAttemptCount).toBe(attemptCount + 1);
    }
  });

  it("7) terminal dead-letter（PATH_MISMATCH 等）は candidate 外で自動 claim しない", async () => {
    const { store, calls } = createFakeStore([
      makeCandidate({ storageCleanupStatus: "FAILED", storageCleanupLastErrorCode: "PATH_MISMATCH" }),
      makeCandidate({
        id: "intent2",
        reservedUploadItemId: "resv2",
        storageCleanupStatus: "FAILED",
        storageCleanupLastErrorCode: "STORAGE_UNAUTHORIZED",
      }),
    ]);
    const { remover, calls: removeCalls } = makeRemover();
    const result = await runIntentSweep(makeDeps(store, remover));
    expect(result.candidates).toBe(0);
    expect(calls.claims).toHaveLength(0);
    expect(removeCalls).toHaveLength(0);
  });

  it("8) 未知 / null / 認識不能 code の FAILED は dead-letter（claim 0）", async () => {
    const { store, calls } = createFakeStore(
      [
        makeCandidate({ storageCleanupStatus: "FAILED", storageCleanupLastErrorCode: "SOME_NEW_CODE" }),
        makeCandidate({
          id: "intent2",
          reservedUploadItemId: "resv2",
          storageCleanupStatus: "FAILED",
          storageCleanupLastErrorCode: null,
        }),
      ],
      { deadLetters: { total: 2, byCode: { SOME_NEW_CODE: 1, UNKNOWN: 1 } } },
    );
    const { remover } = makeRemover();
    const result = await runIntentSweep(makeDeps(store, remover));
    expect(result.candidates).toBe(0);
    expect(calls.claims).toHaveLength(0);
    expect(result.deadLetterTotal).toBe(2);
  });

  it("9) active finalize lease 中は skip（claim しない）", async () => {
    const { store, calls } = createFakeStore([
      makeCandidate({ finalizeLeaseUntil: new Date(NOW.getTime() + 60_000) }),
    ]);
    const { remover, calls: removeCalls } = makeRemover();
    const result = await runIntentSweep(makeDeps(store, remover));
    expect(result.skipped).toBe(1);
    expect(calls.claims).toHaveLength(0);
    expect(removeCalls).toHaveLength(0);
  });

  it("10) active intent cleanup claim 中は skip", async () => {
    const { store, calls } = createFakeStore([
      makeCandidate({ cleanupLeaseUntil: new Date(NOW.getTime() + 60_000) }),
    ]);
    const { remover } = makeRemover();
    const result = await runIntentSweep(makeDeps(store, remover));
    expect(result.skipped).toBe(1);
    expect(calls.claims).toHaveLength(0);
  });

  it("11) active session cleanup claim 中は skip", async () => {
    const { store, calls } = createFakeStore([
      makeCandidate({ sessionCleanupLeaseUntil: new Date(NOW.getTime() + 60_000) }),
    ]);
    const { remover } = makeRemover();
    const result = await runIntentSweep(makeDeps(store, remover));
    expect(result.skipped).toBe(1);
    expect(calls.claims).toHaveLength(0);
  });

  it("12) PREPARED が finalize deadline 内なら STILL_FINALIZABLE skip（安全弁）", async () => {
    const { store, calls } = createFakeStore([
      makeCandidate({
        status: "PREPARED",
        // 期限値変更で notBefore <= now < deadline になった仮定の状態。
        intentFinalizeDeadlineAt: new Date(NOW.getTime() + HOUR),
      }),
    ]);
    const { remover, calls: removeCalls } = makeRemover();
    const result = await runIntentSweep(makeDeps(store, remover));
    expect(result.skipped).toBe(1);
    expect(calls.claims).toHaveLength(0);
    expect(removeCalls).toHaveLength(0);
  });
});

describe("intentSweepCore — expiry", () => {
  it("13) PREPARED + deadline 超過は claim と同一 guarded 処理で EXPIRED 化して cleanup する", async () => {
    const { store, state } = createFakeStore([makeCandidate({ status: "PREPARED" })]);
    const { remover } = makeRemover();
    const result = await runIntentSweep(makeDeps(store, remover));
    expect(result.cleaned).toBe(1);
    expect(result.expired).toBe(1);
    const row = state.get("intent1")!;
    expect(row.status).toBe("EXPIRED");
    expect(row.storageCleanupStatus).toBe("DONE");
  });

  it("14) stale FINALIZING（lease 失効）+ deadline 超過も EXPIRED 化する", async () => {
    const { store, state } = createFakeStore([
      makeCandidate({
        status: "FINALIZING",
        finalizeLeaseUntil: new Date(NOW.getTime() - 1),
      }),
    ]);
    const { remover } = makeRemover();
    const result = await runIntentSweep(makeDeps(store, remover));
    expect(result.expired).toBe(1);
    expect(state.get("intent1")!.status).toBe("EXPIRED");
  });

  it("15) active FINALIZING は deadline 超過でも EXPIRED 化しない（skip）", async () => {
    const { store, state, calls } = createFakeStore([
      makeCandidate({
        status: "FINALIZING",
        finalizeLeaseUntil: new Date(NOW.getTime() + 60_000),
      }),
    ]);
    const { remover } = makeRemover();
    const result = await runIntentSweep(makeDeps(store, remover));
    expect(result.skipped).toBe(1);
    expect(calls.claims).toHaveLength(0);
    expect(state.get("intent1")!.status).toBe("FINALIZING");
  });
});

describe("intentSweepCore — C' ownership / path plan", () => {
  it("16) FINALIZED + live UploadItem は staging のみ削除（canonical / variants は触らない）", async () => {
    const canonical = tempOriginalPath(W, S, "resv1", "jpg");
    const { store } = createFakeStore([
      makeCandidate({ canonicalOriginalPath: canonical, liveUploadItemExists: true }),
    ]);
    const { remover, calls: removeCalls } = makeRemover();
    const result = await runIntentSweep(makeDeps(store, remover));
    expect(result.cleaned).toBe(1);
    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0]).toEqual([intentStagingOriginalPath(W, S, "intent1")]);
  });

  it("17) FINALIZED + live item なしは staging + canonical + thumbnail + preview を削除", async () => {
    const canonical = tempOriginalPath(W, S, "resv1", "jpg");
    const { store } = createFakeStore([
      makeCandidate({ canonicalOriginalPath: canonical, liveUploadItemExists: false }),
    ]);
    const { remover, calls: removeCalls } = makeRemover();
    const result = await runIntentSweep(makeDeps(store, remover));
    expect(result.cleaned).toBe(1);
    expect(removeCalls[0]).toEqual([
      intentStagingOriginalPath(W, S, "intent1"),
      canonical,
      tempThumbnailPath(W, S, "resv1"),
      tempPreviewPath(W, S, "resv1"),
    ]);
  });

  it("18) COMMITTED session の intent でも staging は回収可能（session status は intent sweep を阻まない）", async () => {
    // session cleanup lease が無効なら、session の業務 status に関係なく
    // notBefore 経過後の staging は intent sweep が回収する。
    const { store, state } = createFakeStore([
      makeCandidate({ liveUploadItemExists: true }),
    ]);
    const { remover, calls: removeCalls } = makeRemover();
    const result = await runIntentSweep(makeDeps(store, remover));
    expect(result.cleaned).toBe(1);
    expect(removeCalls).toHaveLength(1);
    expect(state.get("intent1")!.storageCleanupStatus).toBe("DONE");
  });

  it("25) staging path が期待値と不一致なら PATH_MISMATCH terminal（Storage remove 0）", async () => {
    const { store, state, calls } = createFakeStore([
      makeCandidate({ stagingOriginalPath: `${W}/upload-intents/${S}/other/original` }),
    ]);
    const { remover, calls: removeCalls } = makeRemover();
    const result = await runIntentSweep(makeDeps(store, remover));

    expect(result.terminalFailed).toBe(1);
    expect(result.cleaned).toBe(0);
    expect(removeCalls).toHaveLength(0);
    expect(calls.failures).toEqual([{ intentId: "intent1", errorCode: "PATH_MISMATCH" }]);
    const row = state.get("intent1")!;
    expect(row.storageCleanupStatus).toBe("FAILED");
    expect(row.storageCleanupLastErrorCode).toBe("PATH_MISMATCH");
    expect(row.cleanupLeaseUntil).toBeNull();
  });

  it("26) 不正 ID segment は IDENTITY_CORRUPT terminal（Storage remove 0）", async () => {
    const { store, calls } = createFakeStore([
      makeCandidate({ reservedUploadItemId: "../evil" }),
    ]);
    const { remover, calls: removeCalls } = makeRemover();
    const result = await runIntentSweep(makeDeps(store, remover));
    expect(result.terminalFailed).toBe(1);
    expect(removeCalls).toHaveLength(0);
    expect(calls.failures).toEqual([{ intentId: "intent1", errorCode: "IDENTITY_CORRUPT" }]);
  });
});

describe("intentSweepCore — claim / attempt", () => {
  it("19) 同一 intent への 2 worker は claim winner 1（Storage remove 1 系統・DONE 1 回）", async () => {
    const { store, state } = createFakeStore([makeCandidate()]);
    const { remover, calls: removeCalls } = makeRemover();
    const [r1, r2] = await Promise.all([
      runIntentSweep(makeDeps(store, remover)),
      runIntentSweep(makeDeps(store, remover)),
    ]);
    expect(r1.cleaned + r2.cleaned).toBe(1);
    expect(removeCalls).toHaveLength(1);
    expect(state.get("intent1")!.storageCleanupStatus).toBe("DONE");
    expect(state.get("intent1")!.storageCleanupAttemptCount).toBe(1);
  });

  it("20) claim 取得時に attemptCount が increment される（観測専用）", async () => {
    const { store, state } = createFakeStore([makeCandidate({ storageCleanupAttemptCount: 4 })]);
    const { remover } = makeRemover();
    await runIntentSweep(makeDeps(store, remover));
    expect(state.get("intent1")!.storageCleanupAttemptCount).toBe(5);
  });

  it("34) session claim race: session guard blocked なら claim 0・snapshot 読込 0・Storage 0", async () => {
    const { store, calls } = createFakeStore([makeCandidate()], {
      claimOverride: () => "session_blocked",
    });
    const { remover, calls: removeCalls } = makeRemover();
    const result = await runIntentSweep(makeDeps(store, remover));
    expect(result.skipped).toBe(1);
    expect(result.claimed).toBe(0);
    expect(removeCalls).toHaveLength(0);
    expect(calls.confirms).toHaveLength(0);
    expect(calls.failures).toHaveLength(0);
  });

  it("35) finalize race: candidate 取得後に状態が変わったら claim conflict で skip（副作用 0）", async () => {
    const { store, calls } = createFakeStore([makeCandidate()], {
      claimOverride: () => "conflict",
    });
    const { remover, calls: removeCalls } = makeRemover();
    const result = await runIntentSweep(makeDeps(store, remover));
    expect(result.skipped).toBe(1);
    expect(removeCalls).toHaveLength(0);
    expect(calls.confirms).toHaveLength(0);
  });

  it("28) claim token 喪失時は別 worker の状態を上書きしない（DONE / FAILED 書込み 0）", async () => {
    const { store, calls } = createFakeStore([makeCandidate()], {
      snapshotOverride: (id) => ({
        ...makeCandidate({ id }),
        cleanupLeaseUntil: new Date(NOW.getTime() + 60_000),
        cleanupAttemptToken: "someone-elses-token",
      }),
    });
    const { remover, calls: removeCalls } = makeRemover();
    const result = await runIntentSweep(makeDeps(store, remover));

    expect(result.cleaned).toBe(0);
    expect(removeCalls).toHaveLength(0);
    expect(calls.confirms).toHaveLength(0);
    expect(calls.failures).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("claim lost"))).toBe(true);
  });
});

describe("intentSweepCore — Storage remove 契約", () => {
  it("21) missing Storage object（削除一覧に不在）は冪等成功として DONE になる", async () => {
    const { store, state } = createFakeStore([makeCandidate()]);
    const { remover } = makeRemover(() => ({ error: null, removedPaths: [] }));
    const result = await runIntentSweep(makeDeps(store, remover));
    expect(result.cleaned).toBe(1);
    expect(result.storageMissing).toBe(1);
    expect(result.storageDeleted).toBe(0);
    expect(state.get("intent1")!.storageCleanupStatus).toBe("DONE");
  });

  it("21b) provider NOT_FOUND error も冪等成功として DONE になる", async () => {
    const { store, state } = createFakeStore([makeCandidate()]);
    const { remover } = makeRemover(() => ({ error: { status: 404 } }));
    const result = await runIntentSweep(makeDeps(store, remover));
    expect(result.cleaned).toBe(1);
    expect(state.get("intent1")!.storageCleanupStatus).toBe("DONE");
  });

  it("22) 429 は STORAGE_RATE_LIMITED retryable（FAILED 記録・lease clear・DB 行残置）", async () => {
    const { store, state } = createFakeStore([makeCandidate()]);
    const { remover } = makeRemover(() => ({ error: { status: 429 } }));
    const result = await runIntentSweep(makeDeps(store, remover));

    expect(result.retryableFailed).toBe(1);
    expect(result.cleaned).toBe(0);
    const row = state.get("intent1")!;
    expect(row.storageCleanupStatus).toBe("FAILED");
    expect(row.storageCleanupLastErrorCode).toBe("STORAGE_RATE_LIMITED");
    expect(row.cleanupLeaseUntil).toBeNull();
    expect(row.cleanupAttemptToken).toBeNull();
    // attempt increment は claim 時の 1 回のみ（failure で二重 increment しない）。
    expect(row.storageCleanupAttemptCount).toBe(1);
  });

  it("23) 5xx / 分類不能 error は STORAGE_UNKNOWN retryable", async () => {
    for (const error of [{ status: 503 }, new Error("boom"), "weird"]) {
      const { store, state } = createFakeStore([makeCandidate()]);
      const { remover } = makeRemover(() => ({ error }));
      const result = await runIntentSweep(makeDeps(store, remover));
      expect(result.retryableFailed).toBe(1);
      expect(state.get("intent1")!.storageCleanupLastErrorCode).toBe("STORAGE_UNKNOWN");
    }
  });

  it("24) 401 / 403 は STORAGE_UNAUTHORIZED terminal（dead-letter へ）", async () => {
    const { store, state } = createFakeStore([makeCandidate()]);
    const { remover } = makeRemover(() => ({ error: { status: 403 } }));
    const result = await runIntentSweep(makeDeps(store, remover));
    expect(result.terminalFailed).toBe(1);
    expect(result.retryableFailed).toBe(0);
    expect(state.get("intent1")!.storageCleanupLastErrorCode).toBe("STORAGE_UNAUTHORIZED");
  });

  it("29) 前半 batch 成功・後半 batch 失敗では進捗を保持し DB 行を残す（次回 missing 収束）", async () => {
    const paths = Array.from({ length: 150 }, (_, i) => `p/${i}`);
    let callIndex = 0;
    const result = await removeStoragePathsInBatches(async (batch) => {
      callIndex += 1;
      if (callIndex === 1) return { error: null, removedPaths: [...batch] };
      return { error: { status: 503 } };
    }, paths);

    expect(result.ok).toBe(false);
    expect(result.deleted).toBe(100); // batch 上限 100 で分割
    if (!result.ok) expect(result.errorCode).toBe("STORAGE_UNKNOWN");
  });

  it("29b) remover が throw しても raw error は normalize され batch 契約は維持される", async () => {
    const result = await removeStoragePathsInBatches(async () => {
      throw Object.assign(new Error("rate limited"), { status: 429 });
    }, ["a"]);
    expect(result).toEqual({ ok: false, errorCode: "STORAGE_RATE_LIMITED", deleted: 0, missing: 0 });
  });
});

describe("intentSweepCore — DB write failure / crash recovery", () => {
  it("27) Storage 成功 → DONE 書込み失敗は DB 行を残し、次回 run で missing → DONE へ収束する", async () => {
    const { store, state, calls } = createFakeStore([makeCandidate()], {
      confirmDoneThrowsOnce: true,
    });
    const removedOnce: string[][] = [];
    const remover: StorageRemover = async (paths) => {
      removedOnce.push([...paths]);
      // 1 回目は実削除成功、2 回目以降は object が既に無い（missing）。
      return removedOnce.length === 1
        ? { error: null, removedPaths: [...paths] }
        : { error: null, removedPaths: [] };
    };

    const first = await runIntentSweep(makeDeps(store, remover));
    expect(first.retryableFailed).toBe(1);
    expect(first.cleaned).toBe(0);
    const afterFirst = state.get("intent1")!;
    expect(afterFirst.storageCleanupStatus).toBe("FAILED");
    expect(afterFirst.storageCleanupLastErrorCode).toBe("DB_WRITE_FAILED");
    expect(calls.failures).toEqual([{ intentId: "intent1", errorCode: "DB_WRITE_FAILED" }]);

    const second = await runIntentSweep(makeDeps(store, remover));
    expect(second.cleaned).toBe(1);
    expect(second.storageMissing).toBe(1);
    expect(state.get("intent1")!.storageCleanupStatus).toBe("DONE");
  });
});

describe("intentSweepCore — run 分離 / metrics / privacy", () => {
  it("31) candidate 間の失敗分離: 1 件の想定外失敗が他 candidate を止めない", async () => {
    const { store, state } = createFakeStore(
      [makeCandidate(), makeCandidate({ id: "intent2", reservedUploadItemId: "resv2" })],
      { claimThrows: new Set(["intent1"]) },
    );
    const { remover } = makeRemover();
    const result = await runIntentSweep(makeDeps(store, remover));

    expect(result.cleaned).toBe(1);
    expect(state.get("intent2")!.storageCleanupStatus).toBe("DONE");
    expect(result.warnings).toContain("intent intent1: sweep failed (UNEXPECTED)");
  });

  it("32) dead-letter count と固定 code 別 count を毎 run 返す", async () => {
    const { store } = createFakeStore([], {
      deadLetters: { total: 3, byCode: { PATH_MISMATCH: 2, STORAGE_UNAUTHORIZED: 1 } },
    });
    const { remover } = makeRemover();
    const result = await runIntentSweep(makeDeps(store, remover));
    expect(result.deadLetterTotal).toBe(3);
    expect(result.deadLetterByCode).toEqual({ PATH_MISMATCH: 2, STORAGE_UNAUTHORIZED: 1 });
  });

  it("33) result は run ごとに独立（shared mutable state なし）", async () => {
    const deadLetters = { total: 1, byCode: { PATH_MISMATCH: 1 } };
    const { store } = createFakeStore([], { deadLetters });
    const { remover } = makeRemover();
    const r1 = await runIntentSweep(makeDeps(store, remover));
    const r2 = await runIntentSweep(makeDeps(store, remover));

    expect(r1).not.toBe(r2);
    expect(r1.deadLetterByCode).not.toBe(r2.deadLetterByCode);
    r1.deadLetterByCode.INJECTED = 99;
    r1.warnings.push("mutated");
    expect(r2.deadLetterByCode).toEqual({ PATH_MISMATCH: 1 });
    expect(r2.warnings).toEqual([]);
    // 注入元の共有 object も汚染しない。
    expect(deadLetters.byCode).toEqual({ PATH_MISMATCH: 1 });
  });

  it("30) result / warnings へ raw path・provider message・token を露出しない", async () => {
    const stagingPath = intentStagingOriginalPath(W, S, "intent1");
    const providerMessage = "SECRET provider detail https://storage.example/bucket?token=abc";
    const { store } = createFakeStore([makeCandidate()]);
    const { remover } = makeRemover(() => ({ error: { status: 500, message: providerMessage } }));
    const deps = makeDeps(store, remover);
    const result = await runIntentSweep(deps);

    const serialized = JSON.stringify(result);
    expect(result.retryableFailed).toBe(1);
    expect(serialized).not.toContain(stagingPath);
    expect(serialized).not.toContain("upload-intents/");
    expect(serialized).not.toContain("SECRET provider detail");
    expect(serialized).not.toContain("token-1");
    expect(serialized).toContain("STORAGE_UNKNOWN"); // 固定分類のみ
  });
});
