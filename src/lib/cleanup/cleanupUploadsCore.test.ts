import { describe, it, expect, vi } from "vitest";
import {
  cleanupUploadsCore,
  classifySessionCleanupUnsafe,
  planSessionCleanupPaths,
  runSessionCleanup,
  IN_FLIGHT_GRACE_MS,
  SESSION_CLEANUP_BATCH_SIZE,
  type CleanupSession,
  type SessionClaimOutcome,
  type SessionCleanupCandidate,
  type SessionCleanupIntentRow,
  type SessionCleanupItemRow,
  type SessionCleanupSnapshot,
  type SessionCleanupStore,
} from "@/lib/cleanup/cleanupUploadsCore";
import type { StorageRemover, StorageRemoveResponse } from "@/lib/upload/intentSweepCore";
import { buildAssetPaths } from "@/lib/commit/commitDecision";
import {
  intentStagingOriginalPath,
  tempOriginalPath,
  tempPreviewPath,
  tempThumbnailPath,
} from "@/lib/upload/storagePaths";

// ---------------------------------------------------------------------------
// Legacy multipart core（既存契約 — 非回帰）
// ---------------------------------------------------------------------------

describe("cleanupUploadsCore", () => {
  it("deletes DB record after successful storage removal", async () => {
    const sessions: CleanupSession[] = [
      { id: "s1", status: "ABANDONED", tempPaths: ["a", "b"] },
    ];
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const res = await cleanupUploadsCore(sessions, {
      removeStorage: vi.fn().mockResolvedValue({ error: null }),
      deleteSession,
    });
    expect(deleteSession).toHaveBeenCalledWith("s1");
    expect(res.deletedSessions).toBe(1);
    expect(res.deletedStoragePaths).toBe(2);
    expect(res.retainedSessions).toBe(0);
  });

  it("does NOT delete DB record when storage removal fails", async () => {
    const sessions: CleanupSession[] = [
      { id: "s1", status: "ACTIVE", tempPaths: ["a"] },
    ];
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const res = await cleanupUploadsCore(sessions, {
      removeStorage: vi.fn().mockResolvedValue({ error: "network error" }),
      deleteSession,
    });
    expect(deleteSession).not.toHaveBeenCalled();
    expect(res.deletedSessions).toBe(0);
    expect(res.retainedSessions).toBe(1);
    expect(res.deletedStoragePaths).toBe(0);
    expect(res.warnings[0]).toContain("storage remove failed");
  });

  it("deletes sessions with no temp paths without touching storage", async () => {
    const sessions: CleanupSession[] = [
      { id: "s1", status: "ABANDONED", tempPaths: [] },
    ];
    const removeStorage = vi.fn();
    const res = await cleanupUploadsCore(sessions, {
      removeStorage,
      deleteSession: vi.fn().mockResolvedValue(undefined),
    });
    expect(removeStorage).not.toHaveBeenCalled();
    expect(res.deletedSessions).toBe(1);
  });

  it("retains a session and warns when DB delete throws", async () => {
    const sessions: CleanupSession[] = [
      { id: "s1", status: "ACTIVE", tempPaths: ["a"] },
    ];
    const res = await cleanupUploadsCore(sessions, {
      removeStorage: vi.fn().mockResolvedValue({ error: null }),
      deleteSession: vi.fn().mockRejectedValue(new Error("status changed to COMMITTED")),
    });
    expect(res.deletedSessions).toBe(0);
    expect(res.retainedSessions).toBe(1);
    // storage was still removed for this session
    expect(res.deletedStoragePaths).toBe(1);
    expect(res.warnings[0]).toContain("DB delete failed");
  });

  it("processes a mixed batch independently per session", async () => {
    const sessions: CleanupSession[] = [
      { id: "ok1", status: "ABANDONED", tempPaths: ["a"] },
      { id: "fail", status: "ACTIVE", tempPaths: ["b"] },
      { id: "ok2", status: "PREVIEWING", tempPaths: [] },
    ];
    const res = await cleanupUploadsCore(sessions, {
      removeStorage: vi.fn(async (paths: string[]) =>
        paths.includes("b") ? { error: "boom" } : { error: null },
      ),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    });
    expect(res.scannedSessions).toBe(3);
    expect(res.deletedSessions).toBe(2);
    expect(res.retainedSessions).toBe(1);
    expect(res.deletedStoragePaths).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 10-43-B3c-3: session storage-first cleanup runtime
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-12T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const W = "w1";
const S = "sess1";
const CUTOFF = new Date(NOW.getTime() - 24 * HOUR);

function makeItem(
  sessionId: string,
  id: string,
  overrides: Partial<SessionCleanupItemRow> = {},
): SessionCleanupItemRow {
  return {
    id,
    uploadStatus: "READY",
    updatedAt: new Date(NOW.getTime() - 2 * HOUR),
    commitStatus: "PENDING",
    commitStartedAt: null,
    committedImageId: null,
    originalExt: "jpg",
    tempStoragePath: tempOriginalPath(W, sessionId, id, "jpg"),
    tempThumbnailPath: tempThumbnailPath(W, sessionId, id),
    tempPreviewPath: tempPreviewPath(W, sessionId, id),
    reservedImageId: null,
    assetStoragePath: null,
    assetThumbnailPath: null,
    assetPreviewPath: null,
    imageRowExists: false,
    ...overrides,
  };
}

function makeIntent(
  sessionId: string,
  id: string,
  overrides: Partial<SessionCleanupIntentRow> = {},
): SessionCleanupIntentRow {
  return {
    id,
    status: "FINALIZED",
    storageCleanupNotBefore: new Date(NOW.getTime() - HOUR),
    finalizeLeaseUntil: null,
    cleanupLeaseUntil: null,
    reservedUploadItemId: `${id}resv`,
    stagingOriginalPath: intentStagingOriginalPath(W, sessionId, id),
    canonicalOriginalPath: null,
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<SessionCleanupCandidate> = {}): SessionCleanupCandidate {
  const id = overrides.id ?? S;
  return {
    id,
    workspaceId: W,
    status: "ABANDONED",
    createdAt: new Date(NOW.getTime() - 48 * HOUR),
    cleanupLeaseUntil: null,
    items: overrides.items ?? [makeItem(id, "item1")],
    intents: [],
    ...overrides,
  };
}

function cloneSnapshot(row: SessionCleanupSnapshot): SessionCleanupSnapshot {
  return {
    ...row,
    items: row.items.map((item) => ({ ...item })),
    intents: row.intents.map((intent) => ({ ...intent })),
  };
}

type SessionFakeOpts = {
  claimOverride?: (sessionId: string) => SessionClaimOutcome | undefined;
  snapshotOverride?: (sessionId: string) => SessionCleanupSnapshot | null | undefined;
  /** deleteSessionGuarded の安全条件チェック直前に state を変異させる hook。 */
  beforeDeleteCheck?: (sessionId: string, state: Map<string, SessionCleanupSnapshot>) => void;
  deleteThrowsOnce?: boolean;
};

function createFakeSessionStore(initial: SessionCleanupCandidate[], opts: SessionFakeOpts = {}) {
  const state = new Map<string, SessionCleanupSnapshot>(
    initial.map((c) => [c.id, cloneSnapshot({ ...c, cleanupAttemptToken: null })]),
  );
  const calls = {
    listArgs: [] as Array<{ cutoff: Date; take: number; scope?: { workspaceId: string; userId: string } }>,
    claims: [] as string[],
    snapshots: [] as string[],
    deletes: [] as string[],
    releases: [] as string[],
    order: [] as string[],
  };
  let deleteThrowsOnce = opts.deleteThrowsOnce ?? false;

  const store: SessionCleanupStore = {
    async listCandidates({ cutoff, take, scope }) {
      calls.listArgs.push({ cutoff, take, scope });
      return [...state.values()]
        .filter((row) => row.createdAt.getTime() < cutoff.getTime())
        .slice(0, take)
        .map(cloneSnapshot);
    },

    async claimSession({ sessionId, attemptToken, leaseUntil, now, freshCutoff }) {
      calls.claims.push(sessionId);
      const override = opts.claimOverride?.(sessionId);
      if (override !== undefined) return override;
      const row = state.get(sessionId);
      if (!row) return { kind: "conflict" };
      if (row.status === "COMMITTED") return { kind: "conflict" };
      if (row.cleanupLeaseUntil !== null && row.cleanupLeaseUntil.getTime() > now.getTime()) {
        return { kind: "conflict" };
      }
      // 実 store と同じく「CAS → 同 tx 内再読込 → unsafe なら rollback」を模す。
      const unsafe = classifySessionCleanupUnsafe(row, now, freshCutoff);
      if (unsafe !== null) return { kind: "unsafe", reason: unsafe };
      row.cleanupLeaseUntil = leaseUntil;
      row.cleanupAttemptToken = attemptToken;
      return { kind: "claimed" };
    },

    async readSessionSnapshot(sessionId) {
      calls.snapshots.push(sessionId);
      const override = opts.snapshotOverride?.(sessionId);
      if (override !== undefined) return override;
      const row = state.get(sessionId);
      return row ? cloneSnapshot(row) : null;
    },

    async releaseSessionClaim({ sessionId, attemptToken }) {
      calls.releases.push(sessionId);
      const row = state.get(sessionId);
      if (row && row.cleanupAttemptToken === attemptToken) {
        row.cleanupLeaseUntil = null;
        row.cleanupAttemptToken = null;
      }
    },

    async deleteSessionGuarded({ sessionId, attemptToken, now, freshCutoff }) {
      calls.deletes.push(sessionId);
      calls.order.push(`delete:${sessionId}`);
      if (deleteThrowsOnce) {
        deleteThrowsOnce = false;
        throw new Error("forced delete failure (test)");
      }
      opts.beforeDeleteCheck?.(sessionId, state);
      const row = state.get(sessionId);
      if (!row) return 0;
      if (row.cleanupAttemptToken !== attemptToken) return 0;
      if (row.status === "COMMITTED") return 0;
      if (classifySessionCleanupUnsafe(row, now, freshCutoff) !== null) return 0;
      state.delete(sessionId);
      return 1;
    },
  };

  return { store, state, calls };
}

function makeRemover(
  behavior?: (paths: readonly string[], callIndex: number) => StorageRemoveResponse,
  order?: string[],
) {
  const calls: string[][] = [];
  const remover: StorageRemover = async (paths) => {
    const index = calls.length;
    calls.push([...paths]);
    order?.push("remove");
    return behavior ? behavior(paths, index) : { error: null, removedPaths: [...paths] };
  };
  return { remover, calls };
}

function makeArgs(
  store: SessionCleanupStore,
  remover: StorageRemover,
  overrides: Partial<Parameters<typeof runSessionCleanup>[0]> = {},
) {
  let tokenIndex = 0;
  return {
    store,
    removeStorage: remover,
    now: () => new Date(NOW),
    generateAttemptToken: () => `token-${++tokenIndex}`,
    cutoff: CUTOFF,
    dryRun: false,
    ...overrides,
  };
}

describe("runSessionCleanup — batch / candidate", () => {
  it("1) session batch は 25 で、超過指定は clamp される", async () => {
    expect(SESSION_CLEANUP_BATCH_SIZE).toBe(25);
    expect(IN_FLIGHT_GRACE_MS).toBe(60 * 60 * 1000);

    const { store, calls } = createFakeSessionStore([makeCandidate()]);
    const { remover } = makeRemover();
    await runSessionCleanup(makeArgs(store, remover, { maxSessions: 100 }));
    expect(calls.listArgs[0].take).toBe(25);

    await runSessionCleanup(makeArgs(store, remover));
    expect(calls.listArgs[1].take).toBe(25);
  });

  it("1b) scope（workspaceId / userId）は store へそのまま渡される", async () => {
    const { store, calls } = createFakeSessionStore([]);
    const { remover } = makeRemover();
    const scope = { workspaceId: W, userId: "user1" };
    await runSessionCleanup(makeArgs(store, remover, { scope }));
    expect(calls.listArgs[0].scope).toEqual(scope);
  });

  it("40) cutoff 対象外・candidate 外の session には一切触れない", async () => {
    const fresh = makeCandidate({ id: "sessFresh", createdAt: new Date(NOW.getTime() - HOUR), items: [] });
    const old = makeCandidate({ id: "sessOld", items: [makeItem("sessOld", "item1")] });
    const { store, state, calls } = createFakeSessionStore([fresh, old]);
    const { remover, calls: removeCalls } = makeRemover();

    const result = await runSessionCleanup(makeArgs(store, remover));
    expect(result.deleted).toBe(1);
    expect(state.has("sessFresh")).toBe(true);
    expect(state.get("sessFresh")!.cleanupAttemptToken).toBeNull();
    expect(calls.claims).toEqual(["sessOld"]);
    for (const batch of removeCalls) {
      for (const path of batch) expect(path).not.toContain("sessFresh");
    }
  });
});

describe("runSessionCleanup — skip 条件（fresh / committed / intent 保護）", () => {
  it("3) fresh UPLOADING（60 分未満）は skip し claim しない", async () => {
    const candidate = makeCandidate({
      items: [makeItem(S, "item1", { uploadStatus: "UPLOADING", updatedAt: new Date(NOW.getTime() - 30 * 60 * 1000) })],
    });
    const { store, state } = createFakeSessionStore([candidate]);
    const { remover, calls: removeCalls } = makeRemover();
    const result = await runSessionCleanup(makeArgs(store, remover));

    expect(result.skippedFreshUploading).toBe(1);
    expect(result.claimed).toBe(0);
    expect(removeCalls).toHaveLength(0);
    expect(state.has(S)).toBe(true);
  });

  it("4) ちょうど 60 分前の UPLOADING は stale として削除できる", async () => {
    const candidate = makeCandidate({
      items: [makeItem(S, "item1", { uploadStatus: "UPLOADING", updatedAt: new Date(NOW.getTime() - IN_FLIGHT_GRACE_MS) })],
    });
    const { store, state } = createFakeSessionStore([candidate]);
    const { remover } = makeRemover();
    const result = await runSessionCleanup(makeArgs(store, remover));
    expect(result.deleted).toBe(1);
    expect(state.has(S)).toBe(false);
  });

  it("5) fresh IN_PROGRESS（commitStartedAt が 60 分未満）は skip", async () => {
    const candidate = makeCandidate({
      items: [
        makeItem(S, "item1", {
          commitStatus: "IN_PROGRESS",
          commitStartedAt: new Date(NOW.getTime() - 10 * 60 * 1000),
        }),
      ],
    });
    const { store } = createFakeSessionStore([candidate]);
    const { remover, calls: removeCalls } = makeRemover();
    const result = await runSessionCleanup(makeArgs(store, remover));
    expect(result.skippedFreshCommit).toBe(1);
    expect(result.claimed).toBe(0);
    expect(removeCalls).toHaveLength(0);
  });

  it("6) ちょうど 60 分前の IN_PROGRESS は stale として削除できる", async () => {
    const candidate = makeCandidate({
      items: [
        makeItem(S, "item1", {
          commitStatus: "IN_PROGRESS",
          commitStartedAt: new Date(NOW.getTime() - IN_FLIGHT_GRACE_MS),
        }),
      ],
    });
    const { store, state } = createFakeSessionStore([candidate]);
    const { remover } = makeRemover();
    const result = await runSessionCleanup(makeArgs(store, remover));
    expect(result.deleted).toBe(1);
    expect(state.has(S)).toBe(false);
  });

  it("7) COMMITTED item を 1 件でも持つ session は skip", async () => {
    const candidate = makeCandidate({
      items: [makeItem(S, "item1"), makeItem(S, "item2", { commitStatus: "COMMITTED", committedImageId: "img1" })],
    });
    const { store, state } = createFakeSessionStore([candidate]);
    const { remover, calls: removeCalls } = makeRemover();
    const result = await runSessionCleanup(makeArgs(store, remover));
    expect(result.skippedCommittedItem).toBe(1);
    expect(removeCalls).toHaveLength(0);
    expect(state.has(S)).toBe(true);
  });

  it("24) committedImageId 非 null は commitStatus に関係なく COMMITTED 保護される", async () => {
    const candidate = makeCandidate({
      items: [makeItem(S, "item1", { commitStatus: "FAILED", committedImageId: "img1" })],
    });
    const { store } = createFakeSessionStore([candidate]);
    const { remover, calls: removeCalls } = makeRemover();
    const result = await runSessionCleanup(makeArgs(store, remover));
    expect(result.skippedCommittedItem).toBe(1);
    expect(removeCalls).toHaveLength(0);
  });

  it("8) COMMITTED session は skip（削除しない）", async () => {
    const candidate = makeCandidate({ status: "COMMITTED", items: [] });
    const { store, state } = createFakeSessionStore([candidate]);
    const { remover } = makeRemover();
    const result = await runSessionCleanup(makeArgs(store, remover));
    expect(result.skippedCommittedSession).toBe(1);
    expect(result.deleted).toBe(0);
    expect(state.has(S)).toBe(true);
  });

  it("9) future storageCleanupNotBefore を持つ intent があれば skip", async () => {
    const candidate = makeCandidate({
      items: [],
      intents: [makeIntent(S, "intent1", { storageCleanupNotBefore: new Date(NOW.getTime() + HOUR) })],
    });
    const { store } = createFakeSessionStore([candidate]);
    const { remover, calls: removeCalls } = makeRemover();
    const result = await runSessionCleanup(makeArgs(store, remover));
    expect(result.skippedFutureNotBefore).toBe(1);
    expect(removeCalls).toHaveLength(0);
  });

  it("10) active finalize lease を持つ intent があれば skip", async () => {
    const candidate = makeCandidate({
      items: [],
      intents: [makeIntent(S, "intent1", { finalizeLeaseUntil: new Date(NOW.getTime() + 60_000) })],
    });
    const { store } = createFakeSessionStore([candidate]);
    const { remover, calls: removeCalls } = makeRemover();
    const result = await runSessionCleanup(makeArgs(store, remover));
    expect(result.skippedFinalizeInProgress).toBe(1);
    expect(removeCalls).toHaveLength(0);
  });

  it("11) active intent cleanup claim を持つ intent があれば skip", async () => {
    const candidate = makeCandidate({
      items: [],
      intents: [makeIntent(S, "intent1", { cleanupLeaseUntil: new Date(NOW.getTime() + 60_000) })],
    });
    const { store } = createFakeSessionStore([candidate]);
    const { remover, calls: removeCalls } = makeRemover();
    const result = await runSessionCleanup(makeArgs(store, remover));
    expect(result.skippedIntentCleanupInProgress).toBe(1);
    expect(removeCalls).toHaveLength(0);
  });

  it("36) intent sweep race: claim tx 内再読込が active intent claim を検出したら rollback して skip", async () => {
    const { store, state } = createFakeSessionStore([makeCandidate({ items: [] })], {
      claimOverride: () => ({ kind: "unsafe", reason: "INTENT_CLEANUP_IN_PROGRESS" }),
    });
    const { remover, calls: removeCalls } = makeRemover();
    const result = await runSessionCleanup(makeArgs(store, remover));

    expect(result.skippedIntentCleanupInProgress).toBe(1);
    expect(result.claimed).toBe(0);
    expect(removeCalls).toHaveLength(0);
    // rollback 済み = claim は残らない。
    expect(state.get(S)!.cleanupAttemptToken).toBeNull();
  });
});

describe("runSessionCleanup — claim / winner", () => {
  it("2) 同一 session への 2 worker は claim winner 1（delete 1 回・Storage 1 系統）", async () => {
    const { store, state } = createFakeSessionStore([makeCandidate()]);
    const { remover, calls: removeCalls } = makeRemover();
    const [r1, r2] = await Promise.all([
      runSessionCleanup(makeArgs(store, remover)),
      runSessionCleanup(makeArgs(store, remover)),
    ]);
    expect(r1.deleted + r2.deleted).toBe(1);
    expect(removeCalls.length).toBe(1);
    expect(state.has(S)).toBe(false);
  });

  it("37) cron worker ×2 相当の連続 run は 2 回目が no-op（冪等）", async () => {
    const { store } = createFakeSessionStore([makeCandidate()]);
    const { remover } = makeRemover();
    const first = await runSessionCleanup(makeArgs(store, remover));
    const second = await runSessionCleanup(makeArgs(store, remover));
    expect(first.deleted).toBe(1);
    expect(second.considered).toBe(0);
    expect(second.deleted).toBe(0);
  });

  it("38) manual worker × cron: 先行 claim が有効な間は後続が claim できない", async () => {
    const candidate = makeCandidate({ cleanupLeaseUntil: new Date(NOW.getTime() + 60_000) });
    const { store, calls } = createFakeSessionStore([candidate]);
    const { remover, calls: removeCalls } = makeRemover();
    const result = await runSessionCleanup(makeArgs(store, remover));
    expect(result.skippedClaimConflict).toBe(1);
    expect(calls.claims).toHaveLength(0); // lease active は claim 試行前に skip
    expect(removeCalls).toHaveLength(0);
  });

  it("39) response loss 相当: 成功 run の後の再 run は candidate 0 で冪等", async () => {
    const { store } = createFakeSessionStore([makeCandidate()]);
    const { remover } = makeRemover();
    await runSessionCleanup(makeArgs(store, remover));
    const rerun = await runSessionCleanup(makeArgs(store, remover));
    expect(rerun).toMatchObject({ considered: 0, claimed: 0, deleted: 0, retained: 0 });
  });

  it("31) claim token 喪失時は delete 0（他 worker の状態を上書きしない）", async () => {
    const candidate = makeCandidate();
    const { store, state, calls } = createFakeSessionStore([candidate], {
      snapshotOverride: (id) => ({
        ...cloneSnapshot({ ...candidate, id, cleanupAttemptToken: null }),
        cleanupLeaseUntil: new Date(NOW.getTime() + 60_000),
        cleanupAttemptToken: "someone-elses-token",
      }),
    });
    const { remover, calls: removeCalls } = makeRemover();
    const result = await runSessionCleanup(makeArgs(store, remover));

    expect(result.retained).toBe(1);
    expect(result.deleted).toBe(0);
    expect(calls.deletes).toHaveLength(0);
    expect(removeCalls).toHaveLength(0);
    expect(state.has(S)).toBe(true);
    expect(result.warnings.some((w) => w.includes("claim lost"))).toBe(true);
  });
});

describe("runSessionCleanup — stable snapshot", () => {
  it("12) Storage 削除対象は claim 前 candidate ではなく claim 後 snapshot から計算する", async () => {
    const candidate = makeCandidate({ items: [makeItem(S, "item1")] });
    // claim 後 snapshot には item2 が増えている（claim 前に駆け込んだ upload）。
    const snapshotWithTwo: SessionCleanupSnapshot = cloneSnapshot({
      ...candidate,
      items: [makeItem(S, "item1"), makeItem(S, "item2")],
      cleanupAttemptToken: "token-1",
      cleanupLeaseUntil: new Date(NOW.getTime() + 60_000),
    });
    const { store, calls } = createFakeSessionStore([candidate], {
      snapshotOverride: () => snapshotWithTwo,
    });
    const { remover, calls: removeCalls } = makeRemover();
    await runSessionCleanup(makeArgs(store, remover));

    expect(calls.snapshots).toEqual([S]);
    expect(removeCalls[0]).toContain(tempOriginalPath(W, S, "item2", "jpg"));
    expect(removeCalls[0]).toHaveLength(6); // 2 items × (original+thumb+preview)
  });

  it("35) item DELETE race: snapshot から消えた item の path は削除対象にしない", async () => {
    const candidate = makeCandidate({
      items: [makeItem(S, "item1"), makeItem(S, "item2")],
      intents: [makeIntent(S, "intent1")],
    });
    const snapshotWithoutItem2: SessionCleanupSnapshot = cloneSnapshot({
      ...candidate,
      items: [makeItem(S, "item1")],
      cleanupAttemptToken: "token-1",
      cleanupLeaseUntil: new Date(NOW.getTime() + 60_000),
    });
    const { store } = createFakeSessionStore([candidate], {
      snapshotOverride: () => snapshotWithoutItem2,
    });
    const { remover, calls: removeCalls } = makeRemover();
    const result = await runSessionCleanup(makeArgs(store, remover));

    expect(result.deleted).toBe(1);
    const removed = removeCalls.flat();
    expect(removed).not.toContain(tempOriginalPath(W, S, "item2", "jpg"));
    expect(removed).toContain(tempOriginalPath(W, S, "item1", "jpg"));
    expect(removed).toContain(intentStagingOriginalPath(W, S, "intent1"));
  });
});

describe("planSessionCleanupPaths — path 収集", () => {
  it("13-16) multipart temp original / thumbnail / preview を収集し、null variant は含めない", () => {
    const plan = planSessionCleanupPaths({
      id: S,
      workspaceId: W,
      items: [
        makeItem(S, "item1"),
        makeItem(S, "item2", { tempThumbnailPath: null, tempPreviewPath: null }),
      ],
      intents: [],
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const paths = plan.entries.map((entry) => entry.path);
    expect(paths).toEqual([
      tempOriginalPath(W, S, "item1", "jpg"),
      tempThumbnailPath(W, S, "item1"),
      tempPreviewPath(W, S, "item1"),
      tempOriginalPath(W, S, "item2", "jpg"),
    ]);
  });

  it("17-18) Direct Upload staging と orphan canonical / variants を収集する", () => {
    const canonical = tempOriginalPath(W, S, "intent1resv", "jpg");
    const plan = planSessionCleanupPaths({
      id: S,
      workspaceId: W,
      items: [],
      intents: [
        makeIntent(S, "intent1", { canonicalOriginalPath: canonical }),
        makeIntent(S, "intent2"), // canonical null → staging のみ
      ],
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const paths = plan.entries.map((entry) => entry.path);
    expect(paths).toEqual([
      intentStagingOriginalPath(W, S, "intent1"),
      canonical,
      tempThumbnailPath(W, S, "intent1resv"),
      tempPreviewPath(W, S, "intent1resv"),
      intentStagingOriginalPath(W, S, "intent2"),
    ]);
  });

  it("18b) live UploadItem を持つ intent の canonical / variants は intent 側から除外され item temp 側で回収される", () => {
    const canonical = tempOriginalPath(W, S, "item1", "jpg");
    const plan = planSessionCleanupPaths({
      id: S,
      workspaceId: W,
      items: [makeItem(S, "item1")],
      intents: [
        makeIntent(S, "intent1", { reservedUploadItemId: "item1", canonicalOriginalPath: canonical }),
      ],
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const paths = plan.entries.map((entry) => entry.path);
    // intent からは staging のみ。canonical(= item temp original) は item plan 由来の 1 回だけ。
    expect(paths.filter((p) => p === canonical)).toHaveLength(1);
    expect(paths).toContain(intentStagingOriginalPath(W, S, "intent1"));
  });

  it("19) 重複 path は dedup される（先勝ち・挿入順維持）", () => {
    const item = makeItem(S, "item1");
    const plan = planSessionCleanupPaths({
      id: S,
      workspaceId: W,
      // store が重複 row を返した場合でも remove 対象は一意になる（防御）。
      items: [item, { ...item }],
      intents: [],
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const paths = plan.entries.map((entry) => entry.path);
    expect(paths).toHaveLength(3);
    expect(new Set(paths).size).toBe(3);
  });

  it("20-21) stale IN_PROGRESS の orphan asset original / thumbnail / preview を回収する", () => {
    const assets = buildAssetPaths({
      workspaceId: W,
      reservedImageId: "img1",
      originalExt: "jpg",
      tempThumbnailPath: tempThumbnailPath(W, S, "item1"),
      tempPreviewPath: tempPreviewPath(W, S, "item1"),
    });
    const plan = planSessionCleanupPaths({
      id: S,
      workspaceId: W,
      items: [
        makeItem(S, "item1", {
          commitStatus: "IN_PROGRESS",
          commitStartedAt: new Date(NOW.getTime() - 2 * HOUR),
          reservedImageId: "img1",
          assetStoragePath: assets.assetStoragePath,
          assetThumbnailPath: assets.assetThumbnailPath,
          assetPreviewPath: assets.assetPreviewPath,
        }),
      ],
      intents: [],
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const paths = plan.entries.map((entry) => entry.path);
    expect(paths).toContain(assets.assetStoragePath);
    expect(paths).toContain(assets.assetThumbnailPath);
    expect(paths).toContain(assets.assetPreviewPath);
  });

  it("22) thumbnail / preview copy 失敗で DB path が null の場合、null path は候補に含めない", () => {
    const assets = buildAssetPaths({
      workspaceId: W,
      reservedImageId: "img1",
      originalExt: "jpg",
      tempThumbnailPath: tempThumbnailPath(W, S, "item1"),
      tempPreviewPath: tempPreviewPath(W, S, "item1"),
    });
    const plan = planSessionCleanupPaths({
      id: S,
      workspaceId: W,
      items: [
        makeItem(S, "item1", {
          commitStatus: "IN_PROGRESS",
          commitStartedAt: new Date(NOW.getTime() - 2 * HOUR),
          reservedImageId: "img1",
          assetStoragePath: assets.assetStoragePath,
          assetThumbnailPath: null, // copy 失敗後の null 補正
          assetPreviewPath: null,
        }),
      ],
      intents: [],
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const paths = plan.entries.map((entry) => entry.path);
    expect(paths).toContain(assets.assetStoragePath);
    expect(paths).not.toContain(assets.assetThumbnailPath);
    expect(paths).not.toContain(assets.assetPreviewPath);
  });

  it("22b) asset original が null で variant だけ非 null の異常行は、非 null expected variant だけを回収する", () => {
    const assets = buildAssetPaths({
      workspaceId: W,
      reservedImageId: "img1",
      originalExt: "jpg",
      tempThumbnailPath: tempThumbnailPath(W, S, "item1"),
      tempPreviewPath: null,
    });
    const plan = planSessionCleanupPaths({
      id: S,
      workspaceId: W,
      items: [
        makeItem(S, "item1", {
          tempPreviewPath: null,
          reservedImageId: "img1",
          assetStoragePath: null,
          assetThumbnailPath: assets.assetThumbnailPath,
          assetPreviewPath: null,
        }),
      ],
      intents: [],
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const paths = plan.entries.map((entry) => entry.path);
    expect(paths).toContain(assets.assetThumbnailPath);
    expect(paths.some((p) => p.includes("/assets/img1/original"))).toBe(false);
  });

  it("23) 正式 Image 行が存在する asset は削除候補に絶対に含めない", () => {
    const assets = buildAssetPaths({
      workspaceId: W,
      reservedImageId: "img1",
      originalExt: "jpg",
      tempThumbnailPath: tempThumbnailPath(W, S, "item1"),
      tempPreviewPath: tempPreviewPath(W, S, "item1"),
    });
    const plan = planSessionCleanupPaths({
      id: S,
      workspaceId: W,
      items: [
        makeItem(S, "item1", {
          reservedImageId: "img1",
          assetStoragePath: assets.assetStoragePath,
          assetThumbnailPath: assets.assetThumbnailPath,
          assetPreviewPath: assets.assetPreviewPath,
          imageRowExists: true, // 正式 Image 行あり
        }),
      ],
      intents: [],
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const paths = plan.entries.map((entry) => entry.path);
    expect(paths.some((p) => p.includes("/assets/"))).toBe(false);
    // temp は回収される。
    expect(paths).toContain(tempOriginalPath(W, S, "item1", "jpg"));
  });
});

describe("runSessionCleanup — path failure（fail-closed）", () => {
  it("25) PATH_MISMATCH が 1 件でもあれば Storage remove 0 / session delete 0 / claim 解放", async () => {
    const candidate = makeCandidate({
      items: [
        makeItem(S, "item1"),
        makeItem(S, "item2", { tempStoragePath: `${W}/uploads/${S}/other/original.jpg` }),
      ],
    });
    const { store, state, calls } = createFakeSessionStore([candidate]);
    const { remover, calls: removeCalls } = makeRemover();
    const result = await runSessionCleanup(makeArgs(store, remover));

    expect(result.pathFailures).toBe(1);
    expect(result.retained).toBe(1);
    expect(result.deleted).toBe(0);
    expect(removeCalls).toHaveLength(0);
    expect(calls.deletes).toHaveLength(0);
    expect(calls.releases).toEqual([S]);
    expect(state.has(S)).toBe(true);
    expect(state.get(S)!.cleanupAttemptToken).toBeNull(); // 解放済み
    expect(result.warnings.some((w) => w.includes("PATH_MISMATCH"))).toBe(true);
  });

  it("26) IDENTITY_CORRUPT（不正 ext / segment）も Storage remove 0 / delete 0", async () => {
    const candidate = makeCandidate({
      items: [makeItem(S, "item1", { originalExt: "exe" })],
    });
    const { store, calls } = createFakeSessionStore([candidate]);
    const { remover, calls: removeCalls } = makeRemover();
    const result = await runSessionCleanup(makeArgs(store, remover));

    expect(result.pathFailures).toBe(1);
    expect(removeCalls).toHaveLength(0);
    expect(calls.deletes).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("IDENTITY_CORRUPT"))).toBe(true);
  });
});

describe("runSessionCleanup — Storage-first / crash recovery", () => {
  it("27) missing object は冪等成功として session delete まで進む", async () => {
    const { store, state } = createFakeSessionStore([makeCandidate()]);
    const { remover } = makeRemover(() => ({ error: null, removedPaths: [] }));
    const result = await runSessionCleanup(makeArgs(store, remover));

    expect(result.deleted).toBe(1);
    expect(result.storageMissing).toBe(3);
    expect(result.storageDeleted).toBe(0);
    expect(state.has(S)).toBe(false);
  });

  it("28) Storage 一部成功・一部失敗では session を残す（進捗は保持）", async () => {
    // 34 items × 3 paths = 102 paths → batch 100 + 2。2 batch 目を失敗させる。
    const items = Array.from({ length: 34 }, (_, i) => makeItem(S, `item${i}`));
    const { store, state, calls } = createFakeSessionStore([makeCandidate({ items })]);
    const { remover } = makeRemover((paths, index) =>
      index === 0 ? { error: null, removedPaths: [...paths] } : { error: { status: 503 } },
    );
    const result = await runSessionCleanup(makeArgs(store, remover));

    expect(result.storageDeleted).toBe(100);
    expect(result.storageFailed).toBe(1);
    expect(result.deleted).toBe(0);
    expect(result.retained).toBe(1);
    expect(calls.deletes).toHaveLength(0); // DB delete は開始すらしない
    expect(state.has(S)).toBe(true);
    expect(state.get(S)!.cleanupAttemptToken).toBeNull(); // claim は解放され次回再試行可能
  });

  it("29) session delete は必ず全 Storage 削除成功の後（DB 先行 delete なし）", async () => {
    const order: string[] = [];
    const { store, calls } = createFakeSessionStore([makeCandidate()]);
    const { remover } = makeRemover(undefined, order);
    await runSessionCleanup(makeArgs(store, remover));

    const merged = [...order, ...calls.order];
    expect(merged.indexOf("remove")).toBeGreaterThanOrEqual(0);
    expect(calls.order).toEqual([`delete:${S}`]);
    // remover は order へ push 済み、delete は calls.order へ push 済み。
    // remove の完了後にのみ delete が呼ばれることを call 順で固定する。
    expect(order).toEqual(["remove"]);
  });

  it("30) Storage 成功 → DB delete 失敗でも DB を強制変更せず、次回 run で missing → delete に収束する", async () => {
    const { store, state } = createFakeSessionStore([makeCandidate()], { deleteThrowsOnce: true });
    let call = 0;
    const remover: StorageRemover = async (paths) => {
      call += 1;
      return call === 1
        ? { error: null, removedPaths: [...paths] }
        : { error: null, removedPaths: [] }; // 2 回目以降は既に消えている
    };

    const first = await runSessionCleanup(makeArgs(store, remover));
    expect(first.deleted).toBe(0);
    expect(first.retained).toBe(1);
    expect(state.has(S)).toBe(true);
    expect(first.warnings.some((w) => w.includes("UNEXPECTED"))).toBe(true);

    const second = await runSessionCleanup(makeArgs(store, remover));
    expect(second.deleted).toBe(1);
    expect(second.storageMissing).toBe(3);
    expect(state.has(S)).toBe(false);
  });

  it("32) final delete 直前に fresh UPLOADING が現れたら delete 0（強制削除しない）", async () => {
    const { store, state } = createFakeSessionStore([makeCandidate()], {
      beforeDeleteCheck: (sessionId, s) => {
        s.get(sessionId)!.items.push(
          makeItem(sessionId, "late", { uploadStatus: "UPLOADING", updatedAt: new Date(NOW.getTime()) }),
        );
      },
    });
    const { remover } = makeRemover();
    const result = await runSessionCleanup(makeArgs(store, remover));

    expect(result.deleted).toBe(0);
    expect(result.retained).toBe(1);
    expect(state.has(S)).toBe(true);
    expect(result.warnings.some((w) => w.includes("final delete guarded out"))).toBe(true);
  });

  it("33) final delete 直前に fresh IN_PROGRESS が現れたら delete 0", async () => {
    const { store, state } = createFakeSessionStore([makeCandidate()], {
      beforeDeleteCheck: (sessionId, s) => {
        const item = s.get(sessionId)!.items[0];
        item.commitStatus = "IN_PROGRESS";
        item.commitStartedAt = new Date(NOW.getTime());
      },
    });
    const { remover } = makeRemover();
    const result = await runSessionCleanup(makeArgs(store, remover));
    expect(result.deleted).toBe(0);
    expect(state.has(S)).toBe(true);
  });

  it("34) final delete 直前に COMMITTED item が現れたら delete 0", async () => {
    const { store, state } = createFakeSessionStore([makeCandidate()], {
      beforeDeleteCheck: (sessionId, s) => {
        const item = s.get(sessionId)!.items[0];
        item.commitStatus = "COMMITTED";
        item.committedImageId = "img1";
      },
    });
    const { remover } = makeRemover();
    const result = await runSessionCleanup(makeArgs(store, remover));
    expect(result.deleted).toBe(0);
    expect(state.has(S)).toBe(true);
  });
});

describe("runSessionCleanup — dryRun / privacy", () => {
  it("42) dryRun は claim 0 / Storage remove 0 / delete 0 で、集計だけを返す", async () => {
    const fresh = makeCandidate({
      id: "sessB",
      items: [makeItem("sessB", "item1", { uploadStatus: "UPLOADING", updatedAt: new Date(NOW.getTime()) })],
    });
    const { store, state, calls } = createFakeSessionStore([makeCandidate(), fresh]);
    const { remover, calls: removeCalls } = makeRemover();
    const result = await runSessionCleanup(makeArgs(store, remover, { dryRun: true }));

    expect(result.considered).toBe(2);
    expect(result.skippedFreshUploading).toBe(1);
    expect(result.plannedStoragePaths).toBe(3); // 削除可能な session の分のみ
    expect(result.claimed).toBe(0);
    expect(result.deleted).toBe(0);
    expect(calls.claims).toHaveLength(0);
    expect(calls.deletes).toHaveLength(0);
    expect(removeCalls).toHaveLength(0);
    expect(state.size).toBe(2);
    // dryRun は attempt token / lease を一切書かない。
    expect(state.get(S)!.cleanupAttemptToken).toBeNull();
    expect(state.get(S)!.cleanupLeaseUntil).toBeNull();
  });

  it("41) result / warnings へ raw path・provider message・token を露出しない", async () => {
    const providerMessage = "SECRET detail https://storage.example/x?token=abc";
    const { store } = createFakeSessionStore([makeCandidate()]);
    const { remover } = makeRemover(() => ({ error: { status: 500, message: providerMessage } }));
    const result = await runSessionCleanup(makeArgs(store, remover));

    const serialized = JSON.stringify(result);
    expect(result.storageFailed).toBe(1);
    expect(serialized).not.toContain("/uploads/");
    expect(serialized).not.toContain("SECRET detail");
    expect(serialized).not.toContain("token-1");
    expect(serialized).toContain("STORAGE_UNKNOWN");
  });
});
