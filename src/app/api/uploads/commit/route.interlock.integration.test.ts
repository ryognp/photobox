// Phase 10-43-B3c-2: POST /api/uploads/commit の session cleanup interlock
// integration test。実 route handler を isolated local Postgres へ向けて駆動し、
// auth / rate limit / copyStorageFile / Supabase remove は mock する(実 Supabase
// へは一切触れない)。
//
// Opt-in via PHOTOBOX_TEST_DATABASE_URL (localhost/127.0.0.1 のみ)。未設定時は
// DB 依存 case を skip する — items route integration test と同じ規律。
//
// race の再現は sleep に依存しない: Prisma Client Extension の query hook で
// route の `uploadSession.updateMany`(N 回目)や copyStorageFile を実行前に hold
// し、その間に Extension を通らない raw SQL で cleanup claim を注入する。
// 全 hold は deferred promise + afterEach 強制 release(hang 防止・順序非依存)。
//
// 行 namespace: 生成する全 row は RUN_NS prefix 配下。cleanup は必ず prefix
// scoped(unscoped deleteMany({}) 禁止)。

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";

const TEST_DATABASE_URL = process.env.PHOTOBOX_TEST_DATABASE_URL;

const RUN_NS = `b3c2_commit_${process.pid}_${crypto.randomUUID()}_`;

function assertLocalOnly(url: string) {
  const parsed = new URL(url);
  if (!["localhost", "127.0.0.1"].includes(parsed.hostname)) {
    throw new Error(`PHOTOBOX_TEST_DATABASE_URL must point at localhost/127.0.0.1 only, got hostname "${parsed.hostname}"`);
  }
}

let currentUserId = `${RUN_NS}unset-user`;

vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => ({ id: currentUserId, email: "test@example.com" }),
}));

vi.mock("@/lib/rateLimit", () => ({
  checkUserRateLimit: async () => ({ allowed: true, enabled: false, source: "mock-disabled" }),
  rateLimitHeaders: () => ({}),
}));

// ---------------------------------------------------------------------------
// Deterministic barrier / knob infrastructure (one-shot, always releasable)
// ---------------------------------------------------------------------------
type Barrier = { onReached: () => void; gate: Promise<void> };

const pendingReleases: Array<() => void> = [];

function armBarrier(assign: (b: Barrier) => void): { reached: Promise<void>; release: () => void } {
  let onReached!: () => void;
  const reached = new Promise<void>((r) => { onReached = r; });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  assign({ onReached, gate });
  pendingReleases.push(release);
  return { reached, release };
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout (${ms}ms) waiting for ${label}`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// copyStorageFile mock — 実 Storage へは触れない。hold / failure knob 付き。
const copyCalls: Array<{ from: string; to: string }> = [];
let copyHoldBarrier: Barrier | null = null;
let failNextCopy = false;

export function __armCopyHold() {
  return armBarrier((b) => { copyHoldBarrier = b; });
}

vi.mock("@/lib/commit/storageCopy", () => ({
  copyStorageFile: async (from: string, to: string) => {
    const hold = copyHoldBarrier;
    if (hold) {
      copyHoldBarrier = null; // one-shot
      hold.onReached();
      await hold.gate;
    }
    if (failNextCopy) {
      failNextCopy = false;
      return { ok: false, message: "mocked copy failure" };
    }
    copyCalls.push({ from, to });
    return { ok: true };
  },
  deleteStorageFile: async () => undefined,
}));

// Supabase admin mock — cleanupTempFiles の remove 呼出しを記録するだけ。
const removeCalls: string[][] = [];
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    storage: {
      from: () => ({
        remove: async (paths: string[]) => {
          removeCalls.push(paths);
          return { error: null };
        },
      }),
    },
  },
}));

// Prisma — isolated local Postgres へ実接続。route の uploadSession.updateMany
// の N 回目(1-based)を実行前に hold できる(interlock=1 / final tx=2 / 最終
// session finalization=3 の順で呼ばれる)。claim 注入は Extension を通らない
// $executeRaw で行う。
let sessionUpdateManyCount = 0;
let sessionHoldTarget: number | null = null;
let sessionHoldBarrier: Barrier | null = null;

export function __holdNthSessionUpdateMany(n: number) {
  sessionUpdateManyCount = 0;
  sessionHoldTarget = n;
  return armBarrier((b) => { sessionHoldBarrier = b; });
}

vi.mock("@/lib/prisma", async () => {
  if (!TEST_DATABASE_URL) return { prisma: null };
  const { PrismaClient } = await import("@/generated/prisma/client");
  const adapter = new PrismaPg({ connectionString: TEST_DATABASE_URL });
  const base = new PrismaClient({ adapter });
  const extended = base.$extends({
    query: {
      uploadSession: {
        async updateMany({ args, query }) {
          sessionUpdateManyCount += 1;
          if (sessionHoldTarget !== null && sessionUpdateManyCount === sessionHoldTarget) {
            sessionHoldTarget = null;
            const barrier = sessionHoldBarrier!;
            sessionHoldBarrier = null;
            barrier.onReached();
            await barrier.gate;
          }
          return query(args);
        },
      },
    },
  });
  return { prisma: extended };
});

const FIXED_MESSAGE = "This session is being cleaned up. Please retry shortly.";
const LEASE_TOKEN = "b3c2-commit-cleanup-token-1234567890";

describe.skipIf(!TEST_DATABASE_URL)("POST /api/uploads/commit — cleanup interlock (isolated Postgres integration)", () => {
  let prisma: import("@/generated/prisma/client").PrismaClient;
  let POST: (typeof import("./route"))["POST"];
  let currentCaseWorkspaceId: string | null = null;

  async function cleanupNamespace(prefix: string) {
    await prisma.imageTag.deleteMany({ where: { workspaceId: { startsWith: prefix } } });
    await prisma.imagePerson.deleteMany({ where: { workspaceId: { startsWith: prefix } } });
    await prisma.prompt.deleteMany({ where: { workspaceId: { startsWith: prefix } } });
    await prisma.image.deleteMany({ where: { workspaceId: { startsWith: prefix } } });
    await prisma.uploadItem.deleteMany({ where: { workspaceId: { startsWith: prefix } } });
    await prisma.uploadSession.deleteMany({ where: { workspaceId: { startsWith: prefix } } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: { startsWith: prefix } } });
    await prisma.workspace.deleteMany({ where: { id: { startsWith: prefix } } });
  }

  async function countNamespace(prefix: string) {
    const counts = await Promise.all([
      prisma.imageTag.count({ where: { workspaceId: { startsWith: prefix } } }),
      prisma.imagePerson.count({ where: { workspaceId: { startsWith: prefix } } }),
      prisma.prompt.count({ where: { workspaceId: { startsWith: prefix } } }),
      prisma.image.count({ where: { workspaceId: { startsWith: prefix } } }),
      prisma.uploadItem.count({ where: { workspaceId: { startsWith: prefix } } }),
      prisma.uploadSession.count({ where: { workspaceId: { startsWith: prefix } } }),
      prisma.workspaceMember.count({ where: { workspaceId: { startsWith: prefix } } }),
      prisma.workspace.count({ where: { id: { startsWith: prefix } } }),
    ]);
    return counts.reduce((a, b) => a + b, 0);
  }

  beforeAll(async () => {
    assertLocalOnly(TEST_DATABASE_URL!);
    ({ prisma } = await import("@/lib/prisma"));
    ({ POST } = await import("./route"));
    await cleanupNamespace(RUN_NS);
  });

  afterAll(async () => {
    let pendingError: unknown;
    try {
      await cleanupNamespace(RUN_NS);
      const remaining = await countNamespace(RUN_NS);
      expect(remaining).toBe(0);
    } catch (e) {
      pendingError = e;
    } finally {
      try {
        await prisma.$disconnect();
      } catch (disconnectError) {
        if (!pendingError) pendingError = disconnectError;
      }
    }
    if (pendingError) throw pendingError;
  });

  afterEach(async () => {
    // 未解決 hold を必ず release(hang 防止)し、knob を毎 test reset する。
    for (const release of pendingReleases.splice(0)) release();
    copyHoldBarrier = null;
    sessionHoldBarrier = null;
    sessionHoldTarget = null;
    sessionUpdateManyCount = 0;
    failNextCopy = false;
    copyCalls.length = 0;
    removeCalls.length = 0;

    if (currentCaseWorkspaceId) {
      await cleanupNamespace(currentCaseWorkspaceId);
      currentCaseWorkspaceId = null;
    }
  });

  async function makeSession(caseLabel: string, status: "PREVIEWING" | "COMMITTED" | "ACTIVE" | "ABANDONED" = "PREVIEWING") {
    const workspaceId = `${RUN_NS}w_${caseLabel}_`;
    const sessionId = `${workspaceId}s`;
    const userId = `${workspaceId}user`;
    currentCaseWorkspaceId = workspaceId;
    currentUserId = userId;
    await prisma.workspace.create({ data: { id: workspaceId, name: "t", slug: workspaceId } });
    await prisma.workspaceMember.create({ data: { workspaceId, userId, role: "owner" } });
    await prisma.uploadSession.create({ data: { id: sessionId, workspaceId, userId, status } });
    return { workspaceId, sessionId, userId };
  }

  type ItemOverrides = Partial<{
    uploadStatus: string;
    promptStatus: string;
    duplicateStatus: string;
    duplicateImageId: string | null;
    commitStatus: string;
    commitStartedAt: Date | null;
    committedImageId: string | null;
    promptDraft: string | null;
    reservedImageId: string | null;
    assetStoragePath: string | null;
  }>;

  async function makeItem(workspaceId: string, sessionId: string, label: string, overrides: ItemOverrides = {}) {
    const id = `${workspaceId}i_${label}`;
    await prisma.uploadItem.create({
      data: {
        id,
        workspaceId,
        sessionId,
        sortOrder: 0,
        originalName: `${label}.jpg`,
        originalExt: "jpg",
        mimeType: "image/jpeg",
        fileSizeBytes: 10,
        fileHash: `${workspaceId}hash_${label}`,
        tempStoragePath: `${workspaceId}/uploads/${sessionId}/${id}/original.jpg`,
        tempThumbnailPath: null,
        tempPreviewPath: null,
        uploadStatus: "READY",
        promptStatus: "FILLED",
        duplicateStatus: "CLEAN",
        commitStatus: "PENDING",
        promptDraft: `prompt for ${label}`,
        ...overrides,
      } as never,
    });
    return id;
  }

  async function setLease(sessionId: string, until: Date) {
    // Client Extension を通らない raw SQL による cleanup claim 注入。
    await prisma.$executeRaw`
      UPDATE "upload_sessions"
         SET "cleanup_lease_until" = ${until},
             "cleanup_attempt_token" = ${LEASE_TOKEN}
       WHERE "id" = ${sessionId}`;
  }

  async function postCommit(sessionId: string, itemIds?: string[]) {
    const body = itemIds ? { sessionId, itemIds } : { sessionId };
    const req = new Request("http://localhost/api/uploads/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return POST(req as unknown as Parameters<typeof POST>[0]);
  }

  async function itemRow(id: string) {
    return prisma.uploadItem.findUniqueOrThrow({ where: { id } });
  }

  async function workspaceCounts(workspaceId: string) {
    const [images, prompts, imageTags, imagePersons] = await Promise.all([
      prisma.image.count({ where: { workspaceId } }),
      prisma.prompt.count({ where: { workspaceId } }),
      prisma.imageTag.count({ where: { workspaceId } }),
      prisma.imagePerson.count({ where: { workspaceId } }),
    ]);
    return { images, prompts, imageTags, imagePersons };
  }

  // --- initial guard --------------------------------------------------------

  it("c1) active cleanup lease → top-level 409 SESSION_CLEANUP_IN_PROGRESS(固定文)", async () => {
    const { workspaceId, sessionId } = await makeSession("c1");
    await makeItem(workspaceId, sessionId, "a");
    await setLease(sessionId, new Date(Date.now() + 60_000));

    const res = await postCommit(sessionId);
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe("SESSION_CLEANUP_IN_PROGRESS");
    expect(json.error.message).toBe(FIXED_MESSAGE);
  });

  it("c2) active lease 中は item write 0・copy 0・Image/Prompt 0", async () => {
    const { workspaceId, sessionId } = await makeSession("c2");
    const itemId = await makeItem(workspaceId, sessionId, "a");
    await setLease(sessionId, new Date(Date.now() + 60_000));

    const res = await postCommit(sessionId);
    expect(res.status).toBe(409);

    const item = await itemRow(itemId);
    expect(item.commitStatus).toBe("PENDING");
    expect(item.reservedImageId).toBeNull();
    expect(item.assetStoragePath).toBeNull();
    expect(item.commitStartedAt).toBeNull();
    expect(copyCalls).toHaveLength(0);
    expect(removeCalls).toHaveLength(0);
    expect(await workspaceCounts(workspaceId)).toEqual({ images: 0, prompts: 0, imageTags: 0, imagePersons: 0 });
  });

  it("c3) active lease の 409 response へ lease timestamp / attempt token を露出しない", async () => {
    const { workspaceId, sessionId } = await makeSession("c3");
    await makeItem(workspaceId, sessionId, "a");
    const until = new Date(Date.now() + 60_000);
    await setLease(sessionId, until);

    const res = await postCommit(sessionId);
    expect(res.status).toBe(409);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain(LEASE_TOKEN);
    expect(text).not.toContain(until.toISOString());
    expect(text).not.toContain("cleanupLeaseUntil");
    expect(text).not.toContain("cleanupAttemptToken");
  });

  it("c4) stale(失効済み) cleanup lease は commit を拒否しない(committed 1)", async () => {
    const { workspaceId, sessionId } = await makeSession("c4");
    const itemId = await makeItem(workspaceId, sessionId, "a");
    await setLease(sessionId, new Date(Date.now() - 1_000));

    const res = await postCommit(sessionId);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.summary.committed).toBe(1);
    expect((await itemRow(itemId)).commitStatus).toBe("COMMITTED");
  });

  // --- race before IN_PROGRESS ---------------------------------------------

  it("c5) race: initial read 通過後・IN_PROGRESS tx guard 直前に claim 取得 → 固定 per-item result・副作用 0", async () => {
    const { workspaceId, sessionId } = await makeSession("c5");
    const itemId = await makeItem(workspaceId, sessionId, "a");
    const { reached, release } = __holdNthSessionUpdateMany(1);

    const responsePromise = postCommit(sessionId);
    try {
      await withTimeout(reached, 3_000, "IN_PROGRESS tx session guard");
      await setLease(sessionId, new Date(Date.now() + 60_000));
    } finally {
      release();
    }

    const res = await withTimeout(responsePromise, 5_000, "race response");
    expect(res.status).toBe(200); // per-item failure(top-level 500 にしない)
    const json = await res.json();
    expect(json.data.summary.failed).toBe(1);
    expect(json.data.failed[0]).toEqual({
      uploadItemId: itemId,
      reason: "SESSION_CLEANUP_IN_PROGRESS",
      message: FIXED_MESSAGE,
    });

    const item = await itemRow(itemId);
    expect(item.commitStatus).toBe("PENDING"); // 元の状態を維持
    expect(item.reservedImageId).toBeNull(); // 新規保存なし
    expect(item.assetStoragePath).toBeNull();
    expect(copyCalls).toHaveLength(0); // asset copy 0
    expect(await workspaceCounts(workspaceId)).toEqual({ images: 0, prompts: 0, imageTags: 0, imagePersons: 0 });
  });

  // --- commit winner marker --------------------------------------------------

  it("c6) commit winner: 最初の copy 開始前(未完了)に IN_PROGRESS + asset paths が DB 確定済み(copy は tx 外)", async () => {
    const { workspaceId, sessionId } = await makeSession("c6");
    const itemId = await makeItem(workspaceId, sessionId, "a");
    const { reached, release } = __armCopyHold();

    const responsePromise = postCommit(sessionId);
    let held: Awaited<ReturnType<typeof itemRow>> | null = null;
    try {
      await withTimeout(reached, 3_000, "copy hold");
      // copy は未完了(copyCalls は完了時に記録)。この時点で別 connection から
      // IN_PROGRESS row が観測できる = interlock tx は copy より先に commit 済み。
      expect(copyCalls).toHaveLength(0);
      held = await itemRow(itemId);
    } finally {
      release();
    }

    expect(held!.commitStatus).toBe("IN_PROGRESS");
    expect(held!.commitStartedAt).not.toBeNull();
    expect(held!.reservedImageId).not.toBeNull();
    expect(held!.assetStoragePath).toBe(`${workspaceId}/assets/${held!.reservedImageId}/original.jpg`);
    expect(held!.assetThumbnailPath).toBeNull(); // temp thumbnail なし → null(期待 nullable 値)
    expect(held!.assetPreviewPath).toBeNull();

    const res = await withTimeout(responsePromise, 5_000, "held commit response");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.summary.committed).toBe(1);
  });

  it("c7) commit winner 完走: committed・Image/Prompt 作成・temp cleanup・session COMMITTED・response shape 不変", async () => {
    const { workspaceId, sessionId } = await makeSession("c7");
    const itemId = await makeItem(workspaceId, sessionId, "a");

    const res = await postCommit(sessionId);
    expect(res.status).toBe(200);
    const json = await res.json();

    // response shape(既存契約)
    expect(Object.keys(json.data).sort()).toEqual(
      ["alreadyCommitted", "committed", "failed", "invalid", "session", "skipped", "summary"].sort(),
    );
    expect(json.data.summary).toEqual({ requested: 1, committed: 1, skipped: 0, alreadyCommitted: 0, failed: 0, invalid: 0 });
    expect(json.data.session).toEqual({ id: sessionId, status: "COMMITTED" });

    const item = await itemRow(itemId);
    expect(item.commitStatus).toBe("COMMITTED");
    expect(item.committedImageId).toBe(item.reservedImageId);
    const counts = await workspaceCounts(workspaceId);
    expect(counts.images).toBe(1);
    expect(counts.prompts).toBe(1);
    expect(copyCalls).toHaveLength(1); // temp thumbnail/preview なし → original 1 copy のみ
    expect(removeCalls.length).toBeGreaterThan(0); // cleanupTempFiles 実行済み
    const session = await prisma.uploadSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.status).toBe("COMMITTED");
  });

  // --- final transaction race -------------------------------------------------

  async function runFinalTxRace(caseLabel: string) {
    const { workspaceId, sessionId } = await makeSession(caseLabel);
    const itemId = await makeItem(workspaceId, sessionId, "a");
    // 1回目 = interlock tx guard(通過) / 2回目 = final tx guard(hold)
    const { reached, release } = __holdNthSessionUpdateMany(2);

    const responsePromise = postCommit(sessionId);
    try {
      await withTimeout(reached, 3_000, "final tx session guard");
      await setLease(sessionId, new Date(Date.now() + 60_000));
    } finally {
      release();
    }
    const res = await withTimeout(responsePromise, 5_000, "final tx race response");
    return { workspaceId, sessionId, itemId, res };
  }

  it("c8) final tx race: 固定 SESSION_CLEANUP_IN_PROGRESS result・Image/Prompt/tag/person 0・COMMITTED 化 0", async () => {
    const { workspaceId, itemId, res } = await runFinalTxRace("c8");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.summary.failed).toBe(1);
    expect(json.data.failed[0]).toEqual({
      uploadItemId: itemId,
      reason: "SESSION_CLEANUP_IN_PROGRESS",
      message: FIXED_MESSAGE,
    });
    expect(await workspaceCounts(workspaceId)).toEqual({ images: 0, prompts: 0, imageTags: 0, imagePersons: 0 });
    const item = await itemRow(itemId);
    expect(item.committedImageId).toBeNull();
    expect(item.commitStatus).not.toBe("COMMITTED");
  });

  it("c9) final tx race: item は IN_PROGRESS + asset paths を維持し、copy 済み asset を route が削除しない", async () => {
    const { itemId, res } = await runFinalTxRace("c9");
    expect(res.status).toBe(200);

    const item = await itemRow(itemId);
    // cleanup ownership を失った後に FAILED 化・path clear をしない(B3c-3 orphan recovery へ委譲)
    expect(item.commitStatus).toBe("IN_PROGRESS");
    expect(item.reservedImageId).not.toBeNull();
    expect(item.assetStoragePath).not.toBeNull();
    expect(item.commitStartedAt).not.toBeNull();
    expect(copyCalls).toHaveLength(1); // copy は成功済み(race は copy 後)
    expect(removeCalls).toHaveLength(0); // asset object も temp も remove しない
  });

  it("c10) final tx race: session status 維持・一般 500 にしない・lease/token 非露出", async () => {
    const { sessionId, res } = await runFinalTxRace("c10");

    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.clone().json());
    expect(text).not.toContain(LEASE_TOKEN);
    expect(text).not.toContain("cleanupLeaseUntil");
    expect(text).not.toContain("cleanupAttemptToken");

    const session = await prisma.uploadSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.status).toBe("PREVIEWING");
    const json = await res.json();
    expect(json.data.session.status).toBe("PREVIEWING");
  });

  // --- session finalization ---------------------------------------------------

  it("c11) finalization race: 全 item COMMITTED 後・session 最終 update 直前に claim 取得 → 強制更新せず既存 status を維持", async () => {
    const { workspaceId, sessionId } = await makeSession("c11");
    const itemId = await makeItem(workspaceId, sessionId, "a");
    // 1=interlock guard / 2=final tx guard / 3=session finalization
    const { reached, release } = __holdNthSessionUpdateMany(3);

    const responsePromise = postCommit(sessionId);
    try {
      await withTimeout(reached, 3_000, "session finalization updateMany");
      await setLease(sessionId, new Date(Date.now() + 60_000));
    } finally {
      release();
    }
    const res = await withTimeout(responsePromise, 5_000, "finalization race response");

    expect(res.status).toBe(200); // 一般 500 にしない
    const json = await res.json();
    expect(json.data.summary.committed).toBe(1); // item 自体は COMMITTED 済み
    expect(json.data.session.status).toBe("PREVIEWING"); // 強制 COMMITTED 化しない

    const session = await prisma.uploadSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.status).toBe("PREVIEWING");
    expect((await itemRow(itemId)).commitStatus).toBe("COMMITTED");
  });

  it("c12) 既に COMMITTED の session は冪等に COMMITTED を返す(already_committed 契約維持)", async () => {
    const { workspaceId, sessionId } = await makeSession("c12", "COMMITTED");
    const imageId = `${workspaceId}img`;
    await makeItem(workspaceId, sessionId, "a", {
      commitStatus: "COMMITTED",
      committedImageId: imageId,
    });

    const res = await postCommit(sessionId);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.summary.alreadyCommitted).toBe(1);
    expect(json.data.session.status).toBe("COMMITTED");
  });

  // --- non-regression ----------------------------------------------------------

  it("c13) duplicate skip 契約は不変(SKIPPED → skipped_duplicate + temp cleanup)", async () => {
    const { workspaceId, sessionId } = await makeSession("c13");
    const dupImageId = `${workspaceId}dupimg`;
    const itemId = await makeItem(workspaceId, sessionId, "a", {
      duplicateStatus: "SKIPPED",
      duplicateImageId: dupImageId,
    });

    const res = await postCommit(sessionId);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.summary.skipped).toBe(1);
    expect(json.data.skipped[0]).toEqual({ uploadItemId: itemId, imageId: dupImageId, status: "skipped_duplicate" });
    const item = await itemRow(itemId);
    expect(item.commitStatus).toBe("COMMITTED");
    expect(item.committedImageId).toBe(dupImageId);
    expect(removeCalls.length).toBeGreaterThan(0); // temp cleanup 実行
    expect(copyCalls).toHaveLength(0); // skip は copy しない
  });

  it("c14) copy failure 契約は不変(STORAGE_COPY_FAILED + FAILED)", async () => {
    const { workspaceId, sessionId } = await makeSession("c14");
    const itemId = await makeItem(workspaceId, sessionId, "a");
    failNextCopy = true;

    const res = await postCommit(sessionId);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.summary.failed).toBe(1);
    expect(json.data.failed[0].reason).toBe("STORAGE_COPY_FAILED");
    const item = await itemRow(itemId);
    expect(item.commitStatus).toBe("FAILED");
    expect(await workspaceCounts(workspaceId)).toEqual({ images: 0, prompts: 0, imageTags: 0, imagePersons: 0 });
  });

  it("c15) timed-out IN_PROGRESS の reset 契約は不変(reset 後に commit 完走)", async () => {
    const { workspaceId, sessionId } = await makeSession("c15");
    const itemId = await makeItem(workspaceId, sessionId, "a", {
      commitStatus: "IN_PROGRESS",
      commitStartedAt: new Date(Date.now() - 6 * 60 * 1000), // 6min 前 > COMMIT_TIMEOUT_MS(5min)
    });

    const res = await postCommit(sessionId);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.summary.committed).toBe(1);
    expect((await itemRow(itemId)).commitStatus).toBe("COMMITTED");
  });

  it("c16) 同一 item への並行 commit で asset copy / Image が重複しない", async () => {
    const { workspaceId, sessionId } = await makeSession("c16");
    await makeItem(workspaceId, sessionId, "a");

    const [res1, res2] = await Promise.all([postCommit(sessionId), postCommit(sessionId)]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    const [json1, json2] = await Promise.all([res1.json(), res2.json()]);

    // 勝者はちょうど 1(敗者は in_progress / already_committed / state conflict のいずれかへ収束)
    expect(json1.data.summary.committed + json2.data.summary.committed).toBe(1);
    expect(copyCalls).toHaveLength(1); // copy の重複なし
    expect((await workspaceCounts(workspaceId)).images).toBe(1);
  });

  it("c17) ACTIVE session の拒否契約は不変(400)", async () => {
    const { workspaceId, sessionId } = await makeSession("c17", "ACTIVE");
    await makeItem(workspaceId, sessionId, "a");

    const res = await postCommit(sessionId);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("VALIDATION_ERROR");
    expect(json.error.message).toContain("PREVIEWING");
  });

  it("c18) ABANDONED session の拒否契約は不変(400)", async () => {
    const { workspaceId, sessionId } = await makeSession("c18", "ABANDONED");
    await makeItem(workspaceId, sessionId, "a");

    const res = await postCommit(sessionId);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("VALIDATION_ERROR");
    expect(json.error.message).toContain("abandoned");
  });
});

// -----------------------------------------------------------------------------
// static contract(DB 不要・常時実行)
// -----------------------------------------------------------------------------
describe("B3c-2 static contract (commit route)", () => {
  it("s1) maxDuration=300 を明示 export し、server-only / force-dynamic を維持している", async () => {
    const routeModule = await import("./route");
    expect(routeModule.maxDuration).toBe(300);
    const fs = await import("node:fs");
    const source = fs.readFileSync(new URL("./route.ts", import.meta.url), "utf8");
    expect(source).toContain("export const maxDuration = 300;");
    expect(source).toContain('import "server-only";');
    expect(source).toContain('export const dynamic = "force-dynamic";');
  });

  it("s2) cleanup claim writer を含まない(lease read / conditional guard のみ = dormant)", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(new URL("./route.ts", import.meta.url), "utf8");
    expect(source).not.toContain("decideClaim");
    expect(source).not.toContain("ownsClaim");
    expect(source).not.toContain("cleanupAttemptToken");
    // lease は guard 条件としてのみ出現する
    expect(source).toContain("isLeaseActive");
    expect(source).toContain("cleanupLeaseUntil: null");
  });

  it("s3) session guard 3 箇所(interlock tx / final tx / finalization)が workspace・user・status・cleanup lease を条件に持つ", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(new URL("./route.ts", import.meta.url), "utf8");

    const guards = source.match(/uploadSession\.updateMany\(\{[\s\S]*?\}\);/g) ?? [];
    expect(guards).toHaveLength(3);

    for (const guard of guards) {
      expect(guard).toContain("workspaceId:");
      expect(guard).toContain("userId:");
      expect(guard).toContain("cleanupLeaseUntil: null");
      expect(guard).toContain("cleanupLeaseUntil: { lte:");
    }
    // interlock tx / final tx は PREVIEWING・COMMITTED を許可
    expect(guards.filter((g) => g.includes('status: { in: ["PREVIEWING", "COMMITTED"] }'))).toHaveLength(2);
    // finalization は非 COMMITTED からの遷移のみ
    expect(guards.filter((g) => g.includes('status: { not: "COMMITTED" }'))).toHaveLength(1);
  });

  it("s4) final transaction では session guard が Image upsert より前に実行される(rollback 等価 mutation の pin)", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(new URL("./route.ts", import.meta.url), "utf8");

    // image.upsert を含む transaction block(= final tx)を切り出す:
    // upsert 位置から直近手前の transaction opener が final tx の開始。
    const upsertIndex = source.indexOf("tx.image.upsert");
    const txStart = source.lastIndexOf("await prisma.$transaction(async (tx) => {", upsertIndex);
    const guardIndex = source.indexOf("tx.uploadSession.updateMany", txStart);
    expect(txStart).toBeGreaterThan(-1);
    expect(guardIndex).toBeGreaterThan(txStart);
    expect(upsertIndex).toBeGreaterThan(guardIndex); // guard が upsert より前

    // guard 失敗は sentinel throw で rollback される(count 0 を握り潰さない)
    const finalTxBlock = source.slice(txStart, upsertIndex);
    expect(finalTxBlock).toContain("throw new SessionCleanupConflictError()");
  });
});
