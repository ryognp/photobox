// Phase 10-43-B3c-3: GET /api/cron/cleanup-uploads（intent sweep + session
// storage-first cleanup）の integration test。実 route handler を isolated
// local Postgres へ向けて駆動し、Storage / auth / rate limit / CRON_SECRET は
// mock する（実 Supabase / 実 Vercel へは一切触れない）。
//
// Opt-in via PHOTOBOX_TEST_DATABASE_URL (localhost/127.0.0.1 のみ)。未設定時は
// DB 依存 case を skip する — 既存 route integration test と同じ規律。
//
// race の再現は sleep に依存しない:
// - 実 claim writer 同士の race は Storage remove / uploadSession.deleteMany を
//   deferred promise barrier で実行前に hold して固定する
// - claim 注入は Prisma Client Extension を通らない $executeRaw で行う
// 全 hold は one-shot + afterEach 強制 release（hang 防止・順序非依存）。
//
// 行 namespace: 生成する全 row は RUN_NS prefix 配下。cleanup は必ず prefix
// scoped（unscoped deleteMany({}) 禁止）。cron の candidate query は global
// だが、他 test file の session は createdAt=now（cutoff 外）・intent は
// storageCleanupNotBefore が未来（+25h）のため sweep 対象にならない。

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  intentStagingOriginalPath,
  tempOriginalPath,
  tempPreviewPath,
  tempThumbnailPath,
} from "@/lib/upload/storagePaths";
import { buildAssetPaths } from "@/lib/commit/commitDecision";

const TEST_DATABASE_URL = process.env.PHOTOBOX_TEST_DATABASE_URL;

const RUN_NS = `b3c3_cron_${process.pid}_${crypto.randomUUID()}_`;
const CRON_SECRET = `cron-secret-${RUN_NS}`;

function assertLocalOnly(url: string) {
  const parsed = new URL(url);
  if (!["localhost", "127.0.0.1"].includes(parsed.hostname)) {
    throw new Error(`PHOTOBOX_TEST_DATABASE_URL must point at localhost/127.0.0.1 only, got hostname "${parsed.hostname}"`);
  }
}

// ---------------------------------------------------------------------------
// auth / rate limit mocks
// ---------------------------------------------------------------------------

let currentUserId: string | null = `${RUN_NS}unset-user`;
let currentWorkspace: { id: string } | null = null;

vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => (currentUserId ? { id: currentUserId, email: "test@example.com" } : null),
  getDefaultWorkspaceForUser: async () => currentWorkspace,
}));

vi.mock("@/lib/rateLimit", () => ({
  checkUserRateLimit: async () => ({ allowed: true, enabled: false, source: "mock-disabled" }),
  rateLimitHeaders: () => ({}),
}));

// ---------------------------------------------------------------------------
// barrier infrastructure（one-shot・afterEach 強制 release）
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

// ---------------------------------------------------------------------------
// Supabase Storage mock（実 Storage へは絶対に触れない）
// ---------------------------------------------------------------------------

const removeCalls: string[][] = [];
const uploadCalls: string[] = [];
let removeHoldBarrier: Barrier | null = null;
let removeBehavior:
  | ((paths: string[]) => { data: Array<{ name: string }> | null; error: unknown })
  | null = null;

export function __armRemoveHold() {
  return armBarrier((b) => { removeHoldBarrier = b; });
}

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    storage: {
      from: () => ({
        remove: async (paths: string[]) => {
          const hold = removeHoldBarrier;
          if (hold) {
            removeHoldBarrier = null; // one-shot
            hold.onReached();
            await hold.gate;
          }
          removeCalls.push([...paths]);
          if (removeBehavior) return removeBehavior(paths);
          return { data: paths.map((name) => ({ name })), error: null };
        },
        upload: async (path: string) => {
          uploadCalls.push(path);
          return { error: null };
        },
        createSignedUrl: async () => ({ data: null, error: new Error("mocked: no real signed URL in test") }),
        createSignedUploadUrl: async () => ({ data: null, error: new Error("mocked") }),
      }),
    },
  },
}));

// ---------------------------------------------------------------------------
// storageCopy mock（commit route 用 — 実 copy なし）
// ---------------------------------------------------------------------------

const copyCalls: Array<{ from: string; to: string }> = [];
vi.mock("@/lib/commit/storageCopy", () => ({
  copyStorageFile: async (from: string, to: string) => {
    copyCalls.push({ from, to });
    return { ok: true };
  },
  deleteStorageFile: async () => undefined,
}));

// ---------------------------------------------------------------------------
// Prisma mock — isolated local Postgres へ実接続 + deleteMany hold barrier
// ---------------------------------------------------------------------------

let sessionDeleteBarrier: Barrier | null = null;

export function __armSessionDeleteHold() {
  return armBarrier((b) => { sessionDeleteBarrier = b; });
}

vi.mock("@/lib/prisma", async () => {
  if (!TEST_DATABASE_URL) return { prisma: null };
  const { PrismaClient } = await import("@/generated/prisma/client");
  const adapter = new PrismaPg({ connectionString: TEST_DATABASE_URL });
  const base = new PrismaClient({ adapter });
  const extended = base.$extends({
    query: {
      uploadSession: {
        // final delete race: token 条件付き deleteMany を実行前に hold し、
        // その間に Extension を通らない経路で状態を変える。
        async deleteMany({ args, query }) {
          const barrier = sessionDeleteBarrier;
          if (barrier) {
            sessionDeleteBarrier = null; // one-shot
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

const FIXED_CLEANUP_MESSAGE = "This session is being cleaned up. Please retry shortly.";
const HOUR = 60 * 60 * 1000;

function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * HOUR);
}

describe.skipIf(!TEST_DATABASE_URL)("GET /api/cron/cleanup-uploads — B3c-3 cleanup runtime (isolated Postgres integration)", () => {
  let prisma: import("@/generated/prisma/client").PrismaClient;
  let GET: (typeof import("./route"))["GET"];
  let manualPost: (typeof import("@/app/api/uploads/cleanup/route"))["POST"];
  let itemsPost: (typeof import("@/app/api/uploads/items/route"))["POST"];
  let commitPost: (typeof import("@/app/api/uploads/commit/route"))["POST"];
  let currentCaseWorkspaceId: string | null = null;
  let savedCronSecret: string | undefined;

  async function cleanupNamespace(prefix: string) {
    await prisma.imageTag.deleteMany({ where: { workspaceId: { startsWith: prefix } } });
    await prisma.imagePerson.deleteMany({ where: { workspaceId: { startsWith: prefix } } });
    await prisma.prompt.deleteMany({ where: { workspaceId: { startsWith: prefix } } });
    await prisma.image.deleteMany({ where: { workspaceId: { startsWith: prefix } } });
    await prisma.uploadIntent.deleteMany({ where: { workspaceId: { startsWith: prefix } } });
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
      prisma.uploadIntent.count({ where: { workspaceId: { startsWith: prefix } } }),
      prisma.uploadItem.count({ where: { workspaceId: { startsWith: prefix } } }),
      prisma.uploadSession.count({ where: { workspaceId: { startsWith: prefix } } }),
      prisma.workspaceMember.count({ where: { workspaceId: { startsWith: prefix } } }),
      prisma.workspace.count({ where: { id: { startsWith: prefix } } }),
    ]);
    return counts.reduce((a, b) => a + b, 0);
  }

  beforeAll(async () => {
    assertLocalOnly(TEST_DATABASE_URL!);
    savedCronSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = CRON_SECRET;
    ({ prisma } = await import("@/lib/prisma"));
    ({ GET } = await import("./route"));
    ({ POST: manualPost } = await import("@/app/api/uploads/cleanup/route"));
    ({ POST: itemsPost } = await import("@/app/api/uploads/items/route"));
    ({ POST: commitPost } = await import("@/app/api/uploads/commit/route"));
    await cleanupNamespace(RUN_NS);
  });

  afterAll(async () => {
    if (savedCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = savedCronSecret;
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
    for (const release of pendingReleases.splice(0)) release();
    removeHoldBarrier = null;
    sessionDeleteBarrier = null;
    removeBehavior = null;
    removeCalls.length = 0;
    uploadCalls.length = 0;
    copyCalls.length = 0;
    currentWorkspace = null;
    process.env.CRON_SECRET = CRON_SECRET;

    if (currentCaseWorkspaceId) {
      await cleanupNamespace(currentCaseWorkspaceId);
      currentCaseWorkspaceId = null;
    }
  });

  // ---- fixtures -------------------------------------------------------------

  async function makeWorkspace(caseLabel: string) {
    const workspaceId = `${RUN_NS}w_${caseLabel}_`;
    const userId = `${workspaceId}user`;
    currentCaseWorkspaceId = workspaceId;
    currentUserId = userId;
    currentWorkspace = { id: workspaceId };
    await prisma.workspace.create({ data: { id: workspaceId, name: "t", slug: workspaceId } });
    await prisma.workspaceMember.create({ data: { workspaceId, userId, role: "owner" } });
    return { workspaceId, userId };
  }

  async function makeSession(
    workspaceId: string,
    userId: string,
    label: string,
    opts: { status?: "ACTIVE" | "PREVIEWING" | "COMMITTED" | "ABANDONED"; createdHoursAgo?: number } = {},
  ) {
    const sessionId = `${workspaceId}s_${label}`;
    await prisma.uploadSession.create({
      data: {
        id: sessionId,
        workspaceId,
        userId,
        status: opts.status ?? "ABANDONED",
        createdAt: hoursAgo(opts.createdHoursAgo ?? 2),
      },
    });
    return sessionId;
  }

  type ItemOverrides = Partial<{
    uploadStatus: string;
    commitStatus: string;
    commitStartedAt: Date | null;
    committedImageId: string | null;
    reservedImageId: string | null;
    assetStoragePath: string | null;
    assetThumbnailPath: string | null;
    assetPreviewPath: string | null;
    tempStoragePath: string;
    tempThumbnailPath: string | null;
    tempPreviewPath: string | null;
  }>;

  async function makeItem(
    workspaceId: string,
    sessionId: string,
    label: string,
    overrides: ItemOverrides = {},
    opts: { updatedHoursAgo?: number } = {},
  ) {
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
        tempStoragePath: tempOriginalPath(workspaceId, sessionId, id, "jpg"),
        tempThumbnailPath: tempThumbnailPath(workspaceId, sessionId, id),
        tempPreviewPath: tempPreviewPath(workspaceId, sessionId, id),
        uploadStatus: "READY",
        promptStatus: "FILLED",
        duplicateStatus: "CLEAN",
        commitStatus: "PENDING",
        promptDraft: `prompt for ${label}`,
        ...overrides,
      } as never,
    });
    if (opts.updatedHoursAgo !== undefined) {
      // @updatedAt を過去へ backdate する（Extension を通らない raw SQL）。
      await prisma.$executeRaw`
        UPDATE "upload_items" SET "updated_at" = ${hoursAgo(opts.updatedHoursAgo)} WHERE "id" = ${id}`;
    }
    return id;
  }

  type IntentOverrides = Partial<{
    status: "PREPARED" | "FINALIZING" | "FINALIZED" | "FAILED" | "EXPIRED" | "CANCELLED";
    storageCleanupStatus: "PENDING" | "DONE" | "FAILED";
    storageCleanupLastErrorCode: string | null;
    storageCleanupNotBefore: Date;
    intentFinalizeDeadlineAt: Date;
    finalizeLeaseUntil: Date | null;
    canonicalOriginalPath: string | null;
    reservedUploadItemId: string;
    uploadItemId: string | null;
  }>;

  let intentSeq = 0;
  async function makeIntent(
    workspaceId: string,
    sessionId: string,
    userId: string,
    label: string,
    overrides: IntentOverrides = {},
  ) {
    const id = `${workspaceId}n_${label}`;
    const reservedUploadItemId = overrides.reservedUploadItemId ?? `${id}resv`;
    await prisma.uploadIntent.create({
      data: {
        id,
        workspaceId,
        sessionId,
        userId,
        reservedUploadItemId,
        clientUploadId: id,
        requestFingerprint: "f".repeat(64),
        declaredOriginalName: "photo.jpg",
        declaredMimeType: "image/jpeg",
        declaredSizeBytes: 10,
        clientFileHash: "h".repeat(64),
        stagingOriginalPath: intentStagingOriginalPath(workspaceId, sessionId, id),
        reservedSortOrder: ++intentSeq,
        variantProfileVersion: "v1",
        tokenIssueDeadlineAt: hoursAgo(4),
        intentFinalizeDeadlineAt: overrides.intentFinalizeDeadlineAt ?? hoursAgo(2),
        storageCleanupNotBefore: overrides.storageCleanupNotBefore ?? hoursAgo(1),
        status: overrides.status ?? "FINALIZED",
        storageCleanupStatus: overrides.storageCleanupStatus ?? "PENDING",
        storageCleanupLastErrorCode: overrides.storageCleanupLastErrorCode ?? null,
        finalizeLeaseUntil: overrides.finalizeLeaseUntil ?? null,
        canonicalOriginalPath: overrides.canonicalOriginalPath ?? null,
        uploadItemId: overrides.uploadItemId ?? null,
        createdAt: hoursAgo(26),
      },
    });
    return { intentId: id, reservedUploadItemId };
  }

  function cronRequest(query = "", authorization: string | null = `Bearer ${CRON_SECRET}`) {
    return new NextRequest(`http://localhost/api/cron/cleanup-uploads${query}`, {
      headers: authorization ? { authorization } : {},
    });
  }

  async function runCron(query = "?olderThanHours=1") {
    const res = await GET(cronRequest(query));
    return { res, json: await res.json() };
  }

  async function intentRow(id: string) {
    return prisma.uploadIntent.findUniqueOrThrow({ where: { id } });
  }

  async function sessionExists(id: string) {
    return (await prisma.uploadSession.findUnique({ where: { id }, select: { id: true } })) !== null;
  }

  async function setSessionLease(sessionId: string, until: Date, token: string) {
    await prisma.$executeRaw`
      UPDATE "upload_sessions"
         SET "cleanup_lease_until" = ${until}, "cleanup_attempt_token" = ${token}
       WHERE "id" = ${sessionId}`;
  }

  async function setIntentLease(intentId: string, until: Date, token: string) {
    await prisma.$executeRaw`
      UPDATE "upload_intents"
         SET "cleanup_lease_until" = ${until}, "cleanup_attempt_token" = ${token}
       WHERE "id" = ${intentId}`;
  }

  // ---- auth / runtime --------------------------------------------------------

  it("a1) CRON_SECRET 未設定は fail-closed（401）", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(cronRequest());
    expect(res.status).toBe(401);
    process.env.CRON_SECRET = CRON_SECRET;
  });

  it("a2) secret 不一致は 401・一致は 200 で既存 response keys を維持する", async () => {
    await makeWorkspace("a2");
    const bad = await GET(cronRequest("", "Bearer wrong-secret"));
    expect(bad.status).toBe(401);

    const { res, json } = await runCron();
    expect(res.status).toBe(200);
    // 既存 keys（非 dryRun）
    for (const key of [
      "dryRun",
      "olderThanHours",
      "scannedSessions",
      "skippedCommittedMixedSessions",
      "deletedSessions",
      "retainedSessions",
      "deletedStoragePaths",
      "warnings",
    ]) {
      expect(json.data, `missing key ${key}`).toHaveProperty(key);
    }
    // B3c-3 additive metrics
    for (const key of ["intentSweep", "sessionsClaimed", "storageDeleted", "pathMismatch", "durationMs"]) {
      expect(json.data).toHaveProperty(key);
    }
    expect(json.data.intentSweep).toHaveProperty("deadLetterTotal");
  });

  it("a3) dryRun=1 は既存 dryRun keys を維持し、side effect 0 で集計だけ返す", async () => {
    const { workspaceId, userId } = await makeWorkspace("a3");
    const sessionId = await makeSession(workspaceId, userId, "x");
    const itemId = await makeItem(workspaceId, sessionId, "a");

    const { res, json } = await runCron("?olderThanHours=1&dryRun=1");
    expect(res.status).toBe(200);
    expect(json.data.dryRun).toBe(true);
    for (const key of ["olderThanHours", "scannedSessions", "skippedCommittedMixedSessions", "plannedStoragePaths"]) {
      expect(json.data).toHaveProperty(key);
    }
    expect(removeCalls).toHaveLength(0);
    expect(await sessionExists(sessionId)).toBe(true);
    expect(await prisma.uploadItem.count({ where: { id: itemId } })).toBe(1);
    const session = await prisma.uploadSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.cleanupAttemptToken).toBeNull();
    expect(session.cleanupLeaseUntil).toBeNull();
  });

  // ---- intent sweep -----------------------------------------------------------

  it("i1) notBefore 前の intent には触らない（claim 0・remove 0・PENDING のまま）", async () => {
    const { workspaceId, userId } = await makeWorkspace("i1");
    // session は cutoff 外にして session cleanup の影響を避ける。
    const sessionId = await makeSession(workspaceId, userId, "x", { createdHoursAgo: 0 });
    const { intentId } = await makeIntent(workspaceId, sessionId, userId, "a", {
      storageCleanupNotBefore: new Date(Date.now() + HOUR),
    });

    await runCron();
    const intent = await intentRow(intentId);
    expect(intent.storageCleanupStatus).toBe("PENDING");
    expect(intent.storageCleanupAttemptCount).toBe(0);
    expect(removeCalls.flat()).not.toContain(intent.stagingOriginalPath);
  });

  it("i2) notBefore 経過 + FINALIZED + item なしは staging + canonical + variants を削除し DONE になる", async () => {
    const { workspaceId, userId } = await makeWorkspace("i2");
    const sessionId = await makeSession(workspaceId, userId, "x", { createdHoursAgo: 0 });
    const reserved = `${workspaceId}n_a_resv`;
    const canonical = tempOriginalPath(workspaceId, sessionId, reserved, "jpg");
    const { intentId } = await makeIntent(workspaceId, sessionId, userId, "a", {
      reservedUploadItemId: reserved,
      canonicalOriginalPath: canonical,
    });

    const { json } = await runCron();
    expect(json.data.intentSweep.cleaned).toBeGreaterThanOrEqual(1);

    const intent = await intentRow(intentId);
    expect(intent.storageCleanupStatus).toBe("DONE");
    expect(intent.storageCleanedAt).not.toBeNull();
    expect(intent.storageCleanupLastErrorCode).toBeNull();
    expect(intent.cleanupLeaseUntil).toBeNull();
    expect(intent.cleanupAttemptToken).toBeNull();
    expect(intent.storageCleanupAttemptCount).toBe(1);

    const removed = removeCalls.flat();
    expect(removed).toContain(intentStagingOriginalPath(workspaceId, sessionId, intentId));
    expect(removed).toContain(canonical);
    expect(removed).toContain(tempThumbnailPath(workspaceId, sessionId, reserved));
    expect(removed).toContain(tempPreviewPath(workspaceId, sessionId, reserved));
  });

  it("i3) FINALIZED + live UploadItem は staging のみ削除し canonical / variants を保護する", async () => {
    const { workspaceId, userId } = await makeWorkspace("i3");
    // fresh session（cutoff 外）に live item を置く。
    const sessionId = await makeSession(workspaceId, userId, "x", { createdHoursAgo: 0 });
    const itemId = await makeItem(workspaceId, sessionId, "live");
    const canonical = tempOriginalPath(workspaceId, sessionId, itemId, "jpg");
    const { intentId } = await makeIntent(workspaceId, sessionId, userId, "a", {
      reservedUploadItemId: itemId,
      canonicalOriginalPath: canonical,
      uploadItemId: itemId,
    });

    await runCron();
    const intent = await intentRow(intentId);
    expect(intent.storageCleanupStatus).toBe("DONE");

    const removed = removeCalls.flat();
    expect(removed).toContain(intentStagingOriginalPath(workspaceId, sessionId, intentId));
    expect(removed).not.toContain(canonical);
    expect(removed).not.toContain(tempThumbnailPath(workspaceId, sessionId, itemId));
    // live item は残る。
    expect(await prisma.uploadItem.count({ where: { id: itemId } })).toBe(1);
  });

  it("i4) COMMITTED session の staging も intent sweep が回収する（session 行は削除しない）", async () => {
    const { workspaceId, userId } = await makeWorkspace("i4");
    const sessionId = await makeSession(workspaceId, userId, "x", { status: "COMMITTED", createdHoursAgo: 30 });
    const itemId = await makeItem(workspaceId, sessionId, "live", {
      commitStatus: "COMMITTED",
      committedImageId: `${workspaceId}img`,
    });
    const { intentId } = await makeIntent(workspaceId, sessionId, userId, "a", {
      reservedUploadItemId: itemId,
      canonicalOriginalPath: tempOriginalPath(workspaceId, sessionId, itemId, "jpg"),
      uploadItemId: itemId,
    });

    await runCron();
    const intent = await intentRow(intentId);
    expect(intent.storageCleanupStatus).toBe("DONE");
    expect(removeCalls.flat()).toContain(intentStagingOriginalPath(workspaceId, sessionId, intentId));
    // COMMITTED session / item は削除されない。
    expect(await sessionExists(sessionId)).toBe(true);
    expect(await prisma.uploadItem.count({ where: { id: itemId } })).toBe(1);
  });

  it("i5) FAILED + retryable 固定分類は attempt 回数に関係なく再試行され DONE へ収束する", async () => {
    const { workspaceId, userId } = await makeWorkspace("i5");
    const sessionId = await makeSession(workspaceId, userId, "x", { createdHoursAgo: 0 });
    const { intentId } = await makeIntent(workspaceId, sessionId, userId, "a", {
      storageCleanupStatus: "FAILED",
      storageCleanupLastErrorCode: "STORAGE_RATE_LIMITED",
    });
    await prisma.uploadIntent.update({
      where: { id: intentId },
      data: { storageCleanupAttemptCount: 100 },
    });

    const { json } = await runCron();
    const intent = await intentRow(intentId);
    expect(intent.storageCleanupStatus).toBe("DONE");
    expect(intent.storageCleanupAttemptCount).toBe(101);
    expect(json.data.intentSweep.cleaned).toBeGreaterThanOrEqual(1);
  });

  it("i6) terminal dead-letter は自動 claim せず、毎 run count を可視化する", async () => {
    const { workspaceId, userId } = await makeWorkspace("i6");
    const sessionId = await makeSession(workspaceId, userId, "x", { createdHoursAgo: 0 });
    const { intentId } = await makeIntent(workspaceId, sessionId, userId, "a", {
      storageCleanupStatus: "FAILED",
      storageCleanupLastErrorCode: "PATH_MISMATCH",
    });

    const { json } = await runCron();
    const intent = await intentRow(intentId);
    expect(intent.storageCleanupStatus).toBe("FAILED");
    expect(intent.storageCleanupLastErrorCode).toBe("PATH_MISMATCH");
    expect(intent.storageCleanupAttemptCount).toBe(0); // claim されていない
    expect(json.data.intentSweep.deadLetterTotal).toBeGreaterThanOrEqual(1);
    expect(json.data.intentSweep.deadLetterByCode.PATH_MISMATCH).toBeGreaterThanOrEqual(1);
  });

  it("i7) missing Storage object は冪等成功として DONE になる", async () => {
    const { workspaceId, userId } = await makeWorkspace("i7");
    const sessionId = await makeSession(workspaceId, userId, "x", { createdHoursAgo: 0 });
    const { intentId } = await makeIntent(workspaceId, sessionId, userId, "a");
    removeBehavior = () => ({ data: [], error: null }); // 削除一覧に対象なし = missing

    const { json } = await runCron();
    const intent = await intentRow(intentId);
    expect(intent.storageCleanupStatus).toBe("DONE");
    expect(json.data.intentSweep.storageMissing).toBeGreaterThanOrEqual(1);
  });

  it("i8) 同一 intent への並行 cron ×2 は claim winner 1（remove 1 系統・DONE 1 回・attempt 1）", async () => {
    const { workspaceId, userId } = await makeWorkspace("i8");
    const sessionId = await makeSession(workspaceId, userId, "x", { createdHoursAgo: 0 });
    const { intentId } = await makeIntent(workspaceId, sessionId, userId, "a");
    const staging = intentStagingOriginalPath(workspaceId, sessionId, intentId);

    const { reached, release } = __armRemoveHold();
    const first = runCron();
    await withTimeout(reached, 15_000, "intent remove hold");
    // worker1 が claim + remove を hold 中に worker2 を完走させる。
    const second = await runCron();
    expect(second.res.status).toBe(200);
    // worker2 は active claim を検出して skip（remove しない）。
    expect(removeCalls.flat().filter((p) => p === staging)).toHaveLength(0);
    release();
    const firstResult = await withTimeout(first, 30_000, "held cron response");
    expect(firstResult.res.status).toBe(200);

    const intent = await intentRow(intentId);
    expect(intent.storageCleanupStatus).toBe("DONE");
    expect(intent.storageCleanupAttemptCount).toBe(1);
    expect(removeCalls.flat().filter((p) => p === staging)).toHaveLength(1);
  });

  it("i9) session cleanup claim 先行時は intent sweep の session guard が block する（intent claim 0）", async () => {
    const { workspaceId, userId } = await makeWorkspace("i9");
    const sessionId = await makeSession(workspaceId, userId, "x", { createdHoursAgo: 0 });
    const { intentId } = await makeIntent(workspaceId, sessionId, userId, "a");
    await setSessionLease(sessionId, new Date(Date.now() + 60_000), "b3c3-session-claim-token-123456789");

    const { json } = await runCron();
    const intent = await intentRow(intentId);
    expect(intent.storageCleanupStatus).toBe("PENDING");
    expect(intent.storageCleanupAttemptCount).toBe(0);
    expect(intent.cleanupAttemptToken).toBeNull();
    expect(json.data.intentSweep.cleaned).toBe(0);
    expect(removeCalls.flat()).not.toContain(intentStagingOriginalPath(workspaceId, sessionId, intentId));
  });

  it("i10) intent cleanup claim 先行時は session cleanup が rollback して session を残す", async () => {
    const { workspaceId, userId } = await makeWorkspace("i10");
    const sessionId = await makeSession(workspaceId, userId, "x", { createdHoursAgo: 2 });
    const { intentId } = await makeIntent(workspaceId, sessionId, userId, "a");
    // intent claim を注入（intent sweep 自身も skip し、session claim tx の再読込が検出する）。
    await setIntentLease(intentId, new Date(Date.now() + 60_000), "b3c3-intent-claim-token-1234567890");

    const { json } = await runCron();
    expect(await sessionExists(sessionId)).toBe(true);
    const session = await prisma.uploadSession.findUniqueOrThrow({ where: { id: sessionId } });
    // rollback 済み = session claim は残らない。
    expect(session.cleanupAttemptToken).toBeNull();
    expect(session.cleanupLeaseUntil).toBeNull();
    expect(json.data.sessionsSkippedIntentCleanupInProgress).toBeGreaterThanOrEqual(1);
    expect(json.data.deletedSessions).toBe(0);
  });

  // ---- session cleanup --------------------------------------------------------

  it("s1) fresh UPLOADING item を持つ session は skip する", async () => {
    const { workspaceId, userId } = await makeWorkspace("s1");
    const sessionId = await makeSession(workspaceId, userId, "x", { status: "ACTIVE" });
    await makeItem(workspaceId, sessionId, "a", { uploadStatus: "UPLOADING" }); // updatedAt = now = fresh

    const { json } = await runCron();
    expect(await sessionExists(sessionId)).toBe(true);
    expect(json.data.sessionsSkippedFreshUploading).toBeGreaterThanOrEqual(1);
    expect(json.data.deletedSessions).toBe(0);
    expect(removeCalls).toHaveLength(0);
  });

  it("s2) stale UPLOADING（60 分以上前）は削除できる", async () => {
    const { workspaceId, userId } = await makeWorkspace("s2");
    const sessionId = await makeSession(workspaceId, userId, "x", { status: "ACTIVE" });
    const itemId = await makeItem(workspaceId, sessionId, "a", { uploadStatus: "UPLOADING" }, { updatedHoursAgo: 2 });

    const { json } = await runCron();
    expect(json.data.deletedSessions).toBe(1);
    expect(await sessionExists(sessionId)).toBe(false);
    expect(removeCalls.flat()).toContain(tempOriginalPath(workspaceId, sessionId, itemId, "jpg"));
  });

  it("s3) fresh IN_PROGRESS（commitStartedAt 60 分未満）は skip する", async () => {
    const { workspaceId, userId } = await makeWorkspace("s3");
    const sessionId = await makeSession(workspaceId, userId, "x", { status: "PREVIEWING" });
    await makeItem(workspaceId, sessionId, "a", { commitStatus: "IN_PROGRESS", commitStartedAt: new Date() });

    const { json } = await runCron();
    expect(await sessionExists(sessionId)).toBe(true);
    expect(json.data.sessionsSkippedFreshCommit).toBeGreaterThanOrEqual(1);
    expect(removeCalls).toHaveLength(0);
  });

  it("s4) stale IN_PROGRESS の orphan asset（reservedImageId・Image 行なし）を回収して session を削除する", async () => {
    const { workspaceId, userId } = await makeWorkspace("s4");
    const sessionId = await makeSession(workspaceId, userId, "x", { status: "PREVIEWING" });
    const itemId = `${workspaceId}i_a`;
    const assets = buildAssetPaths({
      workspaceId,
      reservedImageId: `${workspaceId}rimg`,
      originalExt: "jpg",
      tempThumbnailPath: tempThumbnailPath(workspaceId, sessionId, itemId),
      tempPreviewPath: tempPreviewPath(workspaceId, sessionId, itemId),
    });
    await makeItem(workspaceId, sessionId, "a", {
      commitStatus: "IN_PROGRESS",
      commitStartedAt: hoursAgo(2),
      reservedImageId: `${workspaceId}rimg`,
      assetStoragePath: assets.assetStoragePath,
      assetThumbnailPath: assets.assetThumbnailPath,
      assetPreviewPath: assets.assetPreviewPath,
    });

    const { json } = await runCron();
    expect(json.data.deletedSessions).toBe(1);
    expect(await sessionExists(sessionId)).toBe(false);
    const removed = removeCalls.flat();
    expect(removed).toContain(assets.assetStoragePath);
    expect(removed).toContain(assets.assetThumbnailPath);
    expect(removed).toContain(assets.assetPreviewPath);
    expect(removed).toContain(tempOriginalPath(workspaceId, sessionId, itemId, "jpg"));
  });

  it("s5) COMMITTED item を持つ session は skip する（既存 skippedCommittedMixedSessions 契約）", async () => {
    const { workspaceId, userId } = await makeWorkspace("s5");
    const sessionId = await makeSession(workspaceId, userId, "x", { status: "PREVIEWING" });
    await makeItem(workspaceId, sessionId, "a", {
      commitStatus: "COMMITTED",
      committedImageId: `${workspaceId}img`,
    });

    const { json } = await runCron();
    expect(await sessionExists(sessionId)).toBe(true);
    expect(json.data.skippedCommittedMixedSessions).toBeGreaterThanOrEqual(1);
    expect(removeCalls).toHaveLength(0);
  });

  it("s6) future storageCleanupNotBefore を持つ intent があれば session を skip する", async () => {
    const { workspaceId, userId } = await makeWorkspace("s6");
    const sessionId = await makeSession(workspaceId, userId, "x");
    await makeIntent(workspaceId, sessionId, userId, "a", {
      storageCleanupNotBefore: new Date(Date.now() + HOUR),
    });

    const { json } = await runCron();
    expect(await sessionExists(sessionId)).toBe(true);
    expect(json.data.sessionsSkippedFutureNotBefore).toBeGreaterThanOrEqual(1);
  });

  it("s7) active finalize lease を持つ intent があれば session を skip する", async () => {
    const { workspaceId, userId } = await makeWorkspace("s7");
    const sessionId = await makeSession(workspaceId, userId, "x");
    await makeIntent(workspaceId, sessionId, userId, "a", {
      status: "FINALIZING",
      finalizeLeaseUntil: new Date(Date.now() + 60_000),
    });

    const { json } = await runCron();
    expect(await sessionExists(sessionId)).toBe(true);
    expect(json.data.sessionsSkippedFinalizeInProgress).toBeGreaterThanOrEqual(1);
  });

  it("s8) multipart temp + Direct Upload staging/canonical を dedup して全削除し、cascade で items/intents も消える。無関係 session は不変", async () => {
    const { workspaceId, userId } = await makeWorkspace("s8");
    const sessionId = await makeSession(workspaceId, userId, "x");
    const itemId = await makeItem(workspaceId, sessionId, "a");
    const orphanReserved = `${workspaceId}n_o_resv`;
    await makeIntent(workspaceId, sessionId, userId, "o", {
      reservedUploadItemId: orphanReserved,
      canonicalOriginalPath: tempOriginalPath(workspaceId, sessionId, orphanReserved, "jpg"),
    });
    // live item を参照する intent（canonical は item temp 側で回収 = dedup 確認）
    await makeIntent(workspaceId, sessionId, userId, "l", {
      reservedUploadItemId: itemId,
      canonicalOriginalPath: tempOriginalPath(workspaceId, sessionId, itemId, "jpg"),
      uploadItemId: itemId,
    });
    // 無関係 session（cutoff 外）
    const unrelated = await makeSession(workspaceId, userId, "unrelated", { createdHoursAgo: 0, status: "ACTIVE" });
    const unrelatedItem = await makeItem(workspaceId, unrelated, "u");

    const { json } = await runCron();
    expect(json.data.deletedSessions).toBe(1);
    expect(await sessionExists(sessionId)).toBe(false);
    expect(await prisma.uploadItem.count({ where: { sessionId } })).toBe(0);
    expect(await prisma.uploadIntent.count({ where: { sessionId } })).toBe(0);

    // session cleanup の remove batch 内に重複 path がない（dedup）。
    const sessionBatches = removeCalls.filter((batch) => batch.some((p) => p.includes(sessionId)));
    for (const batch of sessionBatches) {
      expect(new Set(batch).size).toBe(batch.length);
    }
    const removed = removeCalls.flat();
    expect(removed).toContain(tempOriginalPath(workspaceId, sessionId, itemId, "jpg"));
    expect(removed.filter((p) => p === tempOriginalPath(workspaceId, sessionId, itemId, "jpg"))).toHaveLength(1);

    // 無関係 session は不変。
    expect(await sessionExists(unrelated)).toBe(true);
    expect(await prisma.uploadItem.count({ where: { id: unrelatedItem } })).toBe(1);
    expect(removed).not.toContain(tempOriginalPath(workspaceId, unrelated, unrelatedItem, "jpg"));
  });

  it("s9) Storage 失敗時は session を残し claim を解放する（DB 先行 delete なし・raw detail 非露出）", async () => {
    const { workspaceId, userId } = await makeWorkspace("s9");
    const sessionId = await makeSession(workspaceId, userId, "x");
    await makeItem(workspaceId, sessionId, "a");
    removeBehavior = () => ({ data: null, error: { status: 503, message: "SECRET provider detail" } });

    const { json } = await runCron();
    expect(json.data.deletedSessions).toBe(0);
    expect(json.data.retainedSessions).toBeGreaterThanOrEqual(1);
    expect(await sessionExists(sessionId)).toBe(true);
    const session = await prisma.uploadSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.cleanupAttemptToken).toBeNull(); // claim 解放済み = 次回再試行可能

    const text = JSON.stringify(json);
    expect(text).not.toContain("SECRET provider detail");
    expect(text).not.toContain(`${workspaceId}/uploads/`);
    expect(text).toContain("STORAGE_UNKNOWN"); // 固定分類のみ
  });

  it("s10) DB path が期待値と不一致なら Storage remove 0 / delete 0 で session を残す", async () => {
    const { workspaceId, userId } = await makeWorkspace("s10");
    const sessionId = await makeSession(workspaceId, userId, "x");
    const itemId = await makeItem(workspaceId, sessionId, "a");
    await prisma.$executeRaw`
      UPDATE "upload_items" SET "temp_storage_path" = ${`${workspaceId}/uploads/${sessionId}/tampered/original.jpg`}
       WHERE "id" = ${itemId}`;

    const { json } = await runCron();
    expect(json.data.pathMismatch).toBeGreaterThanOrEqual(1);
    expect(json.data.deletedSessions).toBe(0);
    expect(await sessionExists(sessionId)).toBe(true);
    expect(removeCalls).toHaveLength(0);
    const text = JSON.stringify(json);
    expect(text).not.toContain("tampered"); // offending path を response へ出さない
  });

  it("s11) 正式 Image 行が存在する asset は削除せず、session だけ削除する", async () => {
    const { workspaceId, userId } = await makeWorkspace("s11");
    const sessionId = await makeSession(workspaceId, userId, "x", { status: "PREVIEWING" });
    const itemId = `${workspaceId}i_a`;
    const reservedImageId = `${workspaceId}rimg`;
    const assets = buildAssetPaths({
      workspaceId,
      reservedImageId,
      originalExt: "jpg",
      tempThumbnailPath: tempThumbnailPath(workspaceId, sessionId, itemId),
      tempPreviewPath: null,
    });
    // crash 途中: Image 行は作成済みだが committedImageId 未設定…ではなく
    // committedImageId が null のまま Image 行が存在する状態を固定する。
    await prisma.image.create({
      data: {
        id: reservedImageId,
        workspaceId,
        storagePath: assets.assetStoragePath,
        originalName: "a.jpg",
        originalExt: "jpg",
        mimeType: "image/jpeg",
        fileSizeBytes: 10,
        fileHash: `${workspaceId}hash_img`,
      },
    });
    await makeItem(workspaceId, sessionId, "a", {
      commitStatus: "FAILED",
      reservedImageId,
      assetStoragePath: assets.assetStoragePath,
      assetThumbnailPath: assets.assetThumbnailPath,
      tempPreviewPath: null,
    });

    const { json } = await runCron();
    expect(json.data.deletedSessions).toBe(1);
    expect(await sessionExists(sessionId)).toBe(false);
    const removed = removeCalls.flat();
    expect(removed).not.toContain(assets.assetStoragePath);
    expect(removed).not.toContain(assets.assetThumbnailPath);
    // 正式 Image 行は不変。
    expect(await prisma.image.count({ where: { id: reservedImageId } })).toBe(1);
  });

  it("s12) final delete race: snapshot 後に fresh UPLOADING が現れたら deleteMany 0 で session を残す", async () => {
    const { workspaceId, userId } = await makeWorkspace("s12");
    const sessionId = await makeSession(workspaceId, userId, "x", { status: "ACTIVE" });
    await makeItem(workspaceId, sessionId, "a");

    const { reached, release } = __armSessionDeleteHold();
    const cronPromise = runCron();
    try {
      await withTimeout(reached, 15_000, "session deleteMany hold");
      // deleteMany 実行前に fresh UPLOADING item を注入（raced upload 相当）。
      await makeItem(workspaceId, sessionId, "late", { uploadStatus: "UPLOADING" });
    } finally {
      release();
    }
    const { json } = await withTimeout(cronPromise, 30_000, "held cron response");

    expect(json.data.deletedSessions).toBe(0);
    expect(json.data.retainedSessions).toBeGreaterThanOrEqual(1);
    expect(await sessionExists(sessionId)).toBe(true);
    expect(json.data.warnings.some((w: string) => w.includes("final delete guarded out"))).toBe(true);
  });

  it("s13) duplicate cron invocation: 2 回目は冪等（対象なし・エラーなし）", async () => {
    const { workspaceId, userId } = await makeWorkspace("s13");
    const sessionId = await makeSession(workspaceId, userId, "x");
    await makeItem(workspaceId, sessionId, "a");

    const first = await runCron();
    expect(first.json.data.deletedSessions).toBe(1);
    const second = await runCron();
    expect(second.res.status).toBe(200);
    expect(second.json.data.deletedSessions).toBe(0);
    expect(await sessionExists(sessionId)).toBe(false);
  });

  it("s14) session batch は 1 invocation あたり 25 まで", async () => {
    const { workspaceId, userId } = await makeWorkspace("s14");
    for (let i = 0; i < 26; i += 1) {
      await makeSession(workspaceId, userId, `b${i}`);
    }

    const first = await runCron();
    expect(first.json.data.scannedSessions).toBe(25);
    expect(first.json.data.deletedSessions).toBe(25);
    const second = await runCron();
    expect(second.json.data.deletedSessions).toBe(1);
    expect(await prisma.uploadSession.count({ where: { workspaceId } })).toBe(0);
  });

  it("s15) intent batch は 1 invocation あたり 100 まで", async () => {
    const { workspaceId, userId } = await makeWorkspace("s15");
    const sessionId = await makeSession(workspaceId, userId, "x", { createdHoursAgo: 0 });
    await prisma.uploadIntent.createMany({
      data: Array.from({ length: 101 }, (_, i) => ({
        id: `${workspaceId}n_b${i}`,
        workspaceId,
        sessionId,
        userId,
        reservedUploadItemId: `${workspaceId}n_b${i}resv`,
        clientUploadId: `${workspaceId}n_b${i}`,
        requestFingerprint: "f".repeat(64),
        declaredOriginalName: "photo.jpg",
        declaredMimeType: "image/jpeg",
        declaredSizeBytes: 10,
        clientFileHash: "h".repeat(64),
        stagingOriginalPath: intentStagingOriginalPath(workspaceId, sessionId, `${workspaceId}n_b${i}`),
        reservedSortOrder: i,
        variantProfileVersion: "v1",
        tokenIssueDeadlineAt: hoursAgo(4),
        intentFinalizeDeadlineAt: hoursAgo(2),
        storageCleanupNotBefore: hoursAgo(1),
        status: "FINALIZED" as const,
        createdAt: hoursAgo(26),
      })),
    });

    const { json } = await runCron();
    expect(json.data.intentSweep.candidates).toBe(100);
    expect(json.data.intentSweep.cleaned).toBe(100);
    const remaining = await prisma.uploadIntent.count({
      where: { workspaceId, storageCleanupStatus: "PENDING" },
    });
    expect(remaining).toBe(1);
  });

  // ---- B3c-2 interlock との結合（cleanup claim 先行） -------------------------

  it("x1) session cleanup claim 先行中は multipart upload が 409 で、新 UploadItem 0 / Storage PUT 0", async () => {
    const { workspaceId, userId } = await makeWorkspace("x1");
    const sessionId = await makeSession(workspaceId, userId, "x", { status: "ACTIVE" });
    await makeItem(workspaceId, sessionId, "a");

    const { reached, release } = __armRemoveHold();
    const cronPromise = runCron();
    let uploadRes: Response;
    try {
      await withTimeout(reached, 15_000, "session remove hold");
      // claim は commit 済み・Storage remove を hold 中 = cleanup claim 先行状態。
      const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("x".repeat(64))]);
      const fd = new FormData();
      fd.append("sessionId", sessionId);
      fd.append("clientFileHash", crypto.createHash("sha256").update(bytes).digest("hex"));
      fd.append("original", new File([new Uint8Array(bytes)], "t.jpg", { type: "image/jpeg" }));
      const req = new Request("http://localhost/api/uploads/items", { method: "POST", body: fd });
      uploadRes = await withTimeout(
        itemsPost(req as unknown as Parameters<typeof itemsPost>[0]),
        15_000,
        "items POST during cleanup claim",
      );
    } finally {
      release();
    }
    await withTimeout(cronPromise, 30_000, "held cron response");

    expect(uploadRes!.status).toBe(409);
    const json = await uploadRes!.json();
    expect(json.error.code).toBe("SESSION_CLEANUP_IN_PROGRESS");
    expect(json.error.message).toBe(FIXED_CLEANUP_MESSAGE);
    expect(uploadCalls).toHaveLength(0); // Storage PUT 0
    expect(await prisma.uploadItem.count({ where: { sessionId } })).toBe(0); // cascade 済み or 新規 0
  });

  it("x2) session cleanup claim 先行中は commit が 409 で、IN_PROGRESS marker 0 / asset copy 0", async () => {
    const { workspaceId, userId } = await makeWorkspace("x2");
    const sessionId = await makeSession(workspaceId, userId, "x", { status: "PREVIEWING" });
    const itemId = await makeItem(workspaceId, sessionId, "a");

    const { reached, release } = __armRemoveHold();
    const cronPromise = runCron();
    let commitRes: Response;
    let heldItemStatus: string | null = null;
    try {
      await withTimeout(reached, 15_000, "session remove hold");
      const req = new Request("http://localhost/api/uploads/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      commitRes = await withTimeout(
        commitPost(req as unknown as Parameters<typeof commitPost>[0]),
        15_000,
        "commit POST during cleanup claim",
      );
      const item = await prisma.uploadItem.findUnique({ where: { id: itemId }, select: { commitStatus: true } });
      heldItemStatus = item?.commitStatus ?? null;
    } finally {
      release();
    }
    await withTimeout(cronPromise, 30_000, "held cron response");

    expect(commitRes!.status).toBe(409);
    const json = await commitRes!.json();
    expect(json.error.code).toBe("SESSION_CLEANUP_IN_PROGRESS");
    expect(copyCalls).toHaveLength(0); // asset copy 0
    expect(heldItemStatus).toBe("PENDING"); // IN_PROGRESS marker 0
  });

  // ---- manual route 互換 -------------------------------------------------------

  function manualRequest(body: unknown) {
    return new NextRequest("http://localhost/api/uploads/cleanup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("m1) manual: 既存 auth 契約（未認証 401 / workspace なし 403）", async () => {
    await makeWorkspace("m1");
    const saved = currentUserId;
    currentUserId = null;
    expect((await manualPost(manualRequest({}))).status).toBe(401);
    currentUserId = saved;
    currentWorkspace = null;
    expect((await manualPost(manualRequest({}))).status).toBe(403);
  });

  it("m2) manual dryRun（default）は side effect 0 で既存 response shape を維持する", async () => {
    const { workspaceId, userId } = await makeWorkspace("m2");
    const sessionId = await makeSession(workspaceId, userId, "x");
    await makeItem(workspaceId, sessionId, "a");

    const res = await manualPost(manualRequest({ olderThanHours: 1 }));
    expect(res.status).toBe(200);
    const json = await res.json();

    // 既存 shape
    expect(json.data.dryRun).toBe(true);
    expect(json.data.olderThanHours).toBe(1);
    expect(Object.keys(json.data.summary).sort()).toEqual(
      ["sessions", "items", "storagePaths", "deletedStoragePaths", "warnings"].sort(),
    );
    expect(json.data.summary).toMatchObject({ sessions: 1, items: 1, storagePaths: 3, deletedStoragePaths: 0 });
    expect(json.data.sessions).toHaveLength(1);
    expect(json.data.sessions[0]).toMatchObject({ id: sessionId, status: "ABANDONED", itemCount: 1 });
    expect(json.data.warnings).toEqual([]);

    // side effect 0
    expect(removeCalls).toHaveLength(0);
    expect(await sessionExists(sessionId)).toBe(true);
    const session = await prisma.uploadSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.cleanupAttemptToken).toBeNull();
    expect(session.cleanupLeaseUntil).toBeNull();
  });

  it("m3) manual dryRun:false は cron と同じ core で storage-first 削除し、scope 外の session に触れない", async () => {
    const { workspaceId, userId } = await makeWorkspace("m3");
    const sessionId = await makeSession(workspaceId, userId, "x");
    const itemId = await makeItem(workspaceId, sessionId, "a");
    // 同 workspace の別ユーザー session は scope 外。
    const otherSessionId = `${workspaceId}s_other`;
    await prisma.uploadSession.create({
      data: {
        id: otherSessionId,
        workspaceId,
        userId: `${workspaceId}other-user`,
        status: "ABANDONED",
        createdAt: hoursAgo(2),
      },
    });

    const res = await manualPost(manualRequest({ olderThanHours: 1, dryRun: false }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.deletedSessions).toBe(1);
    expect(json.data.summary.deletedStoragePaths).toBe(3);
    expect(await sessionExists(sessionId)).toBe(false);
    expect(removeCalls.flat()).toContain(tempOriginalPath(workspaceId, sessionId, itemId, "jpg"));
    // scope 外は不変。
    expect(await sessionExists(otherSessionId)).toBe(true);
  });

  it("m4) manual: Storage 失敗時は DB を先行削除しない（session 残置・raw detail 非露出）", async () => {
    const { workspaceId, userId } = await makeWorkspace("m4");
    const sessionId = await makeSession(workspaceId, userId, "x");
    await makeItem(workspaceId, sessionId, "a");
    removeBehavior = () => ({ data: null, error: { status: 429, message: "SECRET rate limit detail" } });

    const res = await manualPost(manualRequest({ olderThanHours: 1, dryRun: false }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.deletedSessions).toBe(0);
    expect(json.data.retainedSessions).toBe(1);
    expect(json.data.summary.warnings).toBeGreaterThanOrEqual(1);
    expect(await sessionExists(sessionId)).toBe(true);

    const text = JSON.stringify(json);
    expect(text).not.toContain("SECRET rate limit detail");
    expect(text).not.toContain(`${workspaceId}/uploads/`);
    expect(text).toContain("STORAGE_RATE_LIMITED");
  });
});

// -----------------------------------------------------------------------------
// static contract（DB 不要・常時実行）
// -----------------------------------------------------------------------------

describe("B3c-3 static contract (cron route)", () => {
  it("st1) maxDuration=60 / force-dynamic / nodejs runtime / POST 405 を維持している", async () => {
    const routeModule = await import("./route");
    expect(routeModule.maxDuration).toBe(60);
    const fs = await import("node:fs");
    const source = fs.readFileSync(new URL("./route.ts", import.meta.url), "utf8");
    expect(source).toContain("export const maxDuration = 60;");
    expect(source).toContain('export const dynamic = "force-dynamic";');
    expect(source).toContain('export const runtime = "nodejs";');
    expect(source).toContain('import "server-only";');

    const res = routeModule.POST();
    expect(res.status).toBe(405);
  });

  it("st2) cron は共通 core（runIntentSweep / runSessionCleanup）だけを実行経路にし、独自 state machine を持たない", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(new URL("./route.ts", import.meta.url), "utf8");
    expect(source).toContain("runIntentSweep");
    expect(source).toContain("runSessionCleanup");
    expect(source).toContain("createPrismaIntentSweepStore");
    expect(source).toContain("createPrismaSessionCleanupStore");
    // route 内で claim / path / eligibility を再実装しない。
    expect(source).not.toContain("decideClaim");
    expect(source).not.toContain("classifyIntentCleanup");
    expect(source).not.toContain("planIntentCleanupPaths");
    expect(source).not.toContain("deleteMany");
  });

  it("st3) manual route は cron と同じ session cleanup core を使用し、bulk delete / 独自削除経路を持たない", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      new URL("../../uploads/cleanup/route.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("runSessionCleanup");
    expect(source).toContain("createPrismaSessionCleanupStore");
    // 旧実装の「Storage をまとめて消してから bulk deleteMany」経路が存在しない。
    expect(source).not.toContain("uploadSession.deleteMany");
    expect(source).not.toContain(".remove(batch)");
    // intent sweep は manual では実行しない（cron 専用 — response 互換のため）。
    expect(source).not.toContain("runIntentSweep");
  });
});
