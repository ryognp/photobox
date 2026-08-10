// Phase 10-43-B1.1: integration test for the sortOrder-reservation rewrite of
// POST /api/uploads/items. Drives the actual route handler (not a
// reimplementation) against an isolated local Postgres; Storage and auth are
// mocked since Storage writes must never touch real Supabase and auth is out
// of scope here.
//
// Opt-in via PHOTOBOX_TEST_DATABASE_URL (isolated, localhost/127.0.0.1 only).
// Skips when unset so a plain `vitest run` doesn't require a live DB —
// consistent with sortOrderReservation.integration.test.ts.
//
// To run: PHOTOBOX_TEST_DATABASE_URL="postgresql://...@127.0.0.1:PORT/db" npx vitest run src/app/api/uploads/items/route.integration.test.ts
//
// Fixture isolation (review fix): this file shares its DB with
// sortOrderReservation.integration.test.ts. Under Vitest's default file
// parallelism both files' `beforeEach` used to run `deleteMany({})` on the
// whole table, wiping each other's fixtures mid-run. Every row this file
// creates is now namespaced under a per-process, per-file-load random prefix
// (RUN_NS), and every cleanup query is scoped to that prefix — never an
// unscoped table-wide delete.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";

const TEST_DATABASE_URL = process.env.PHOTOBOX_TEST_DATABASE_URL;

// Unique per test-process + per file load, so concurrent Vitest file workers
// (and even repeated invocations against the same DB) never collide.
const RUN_NS = `b11_route_${process.pid}_${crypto.randomUUID()}_`;

function assertLocalOnly(url: string) {
  const parsed = new URL(url);
  if (!["localhost", "127.0.0.1"].includes(parsed.hostname)) {
    throw new Error(`PHOTOBOX_TEST_DATABASE_URL must point at localhost/127.0.0.1 only, got hostname "${parsed.hostname}"`);
  }
}

// The user id is namespaced per test case (set by makeSession() below), not
// a fixed cross-case/cross-file value. The auth mock reads this mutable
// binding so `getCurrentUser()` returns the current case's namespaced user
// for every request the route makes during that test.
let currentUserId = `${RUN_NS}unset-user`;
const uploadCalls: Array<{ path: string }> = [];

vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => ({ id: currentUserId, email: "test@example.com" }),
}));

// ---------------------------------------------------------------------------
// Phase 10-43-B3c-2: deterministic barrier knobs.
//
// sleep 順序に依存せず race を再現するため、(a) route の transaction session
// guard (`tx.uploadSession.updateMany`) と (b) 最初の Storage PUT を、query /
// call 実行前に hold できるようにする。全て one-shot・deferred promise 方式で、
// afterEach が未解決の hold を必ず release する(失敗時も suite を hang させない)。
// ---------------------------------------------------------------------------
type Barrier = { onReached: () => void; gate: Promise<void> };

let sessionGuardBarrier: Barrier | null = null;
let uploadHoldBarrier: Barrier | null = null;
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

export function __armSessionGuardBarrier() {
  return armBarrier((b) => { sessionGuardBarrier = b; });
}

export function __armUploadHold() {
  return armBarrier((b) => { uploadHoldBarrier = b; });
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

// Storage must never be touched for real in this test — every call succeeds
// deterministically so we can assert purely on DB state and on whether
// Storage was invoked at all (never() checks for the rollback/failure cases).
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    storage: {
      from: () => ({
        upload: async (path: string) => {
          const hold = uploadHoldBarrier;
          if (hold) {
            uploadHoldBarrier = null; // one-shot
            hold.onReached();
            await hold.gate;
          }
          uploadCalls.push({ path });
          return { error: null };
        },
        remove: async () => ({ error: null }),
        createSignedUrl: async () => ({ data: null, error: new Error("mocked: no real signed URL in test") }),
      }),
    },
  },
}));

// Route imports the `prisma` singleton, which reads DATABASE_URL from the
// environment at import time (src/lib/database-url.ts). Rather than racing
// module import order, replace the singleton with our own client pointed at
// the isolated test DB.
// Failure injection for test 4 (create-failure rollback). A plain vi.spyOn on
// `prisma.uploadItem.create` does NOT intercept `tx.uploadItem.create` inside
// an interactive transaction — Prisma constructs a fresh per-transaction
// delegate, not the same object reference. A Prisma Client Extension's query
// hook, by contrast, wraps the query pipeline itself and is honored inside
// `$transaction` callbacks derived from the extended client, so it reliably
// intercepts the route's `tx.uploadItem.create(...)` call.
let forceNextUploadItemCreateFailure = false;
export function __forceNextUploadItemCreateFailure() {
  forceNextUploadItemCreateFailure = true;
}

vi.mock("@/lib/prisma", async () => {
  if (!TEST_DATABASE_URL) return { prisma: null };
  const { PrismaClient } = await import("@/generated/prisma/client");
  const adapter = new PrismaPg({ connectionString: TEST_DATABASE_URL });
  const base = new PrismaClient({ adapter });
  const extended = base.$extends({
    query: {
      uploadItem: {
        async create({ args, query }) {
          if (forceNextUploadItemCreateFailure) {
            forceNextUploadItemCreateFailure = false;
            throw new Error("forced create failure (test)");
          }
          return query(args);
        },
      },
      // B3c-2: route の transaction session guard を query 実行前に hold する。
      // Client Extension は `$transaction` callback 由来の tx client にも効く。
      // barrier 中の claim 注入は、この Extension を通らない $executeRaw
      // (raw SQL) で行う。
      uploadSession: {
        async updateMany({ args, query }) {
          const barrier = sessionGuardBarrier;
          if (barrier) {
            sessionGuardBarrier = null; // one-shot
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

describe.skipIf(!TEST_DATABASE_URL)("POST /api/uploads/items — sortOrder reservation (isolated Postgres integration)", () => {
  let prisma: import("@/generated/prisma/client").PrismaClient;
  let POST: (typeof import("./route"))["POST"];
  let sortOrderReservationModule: typeof import("@/lib/upload/sortOrderReservation");
  let currentCaseWorkspaceId: string | null = null;

  // Namespace-scoped cleanup only — never an unscoped deleteMany({}). FK
  // order: UploadItem -> UploadSession -> WorkspaceMember -> Workspace.
  async function cleanupNamespace(prefix: string) {
    await prisma.uploadItem.deleteMany({ where: { workspaceId: { startsWith: prefix } } });
    await prisma.uploadSession.deleteMany({ where: { workspaceId: { startsWith: prefix } } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: { startsWith: prefix } } });
    await prisma.workspace.deleteMany({ where: { id: { startsWith: prefix } } });
  }

  async function countNamespace(prefix: string) {
    const [items, sessions, members, workspaces] = await Promise.all([
      prisma.uploadItem.count({ where: { workspaceId: { startsWith: prefix } } }),
      prisma.uploadSession.count({ where: { workspaceId: { startsWith: prefix } } }),
      prisma.workspaceMember.count({ where: { workspaceId: { startsWith: prefix } } }),
      prisma.workspace.count({ where: { id: { startsWith: prefix } } }),
    ]);
    return items + sessions + members + workspaces;
  }

  beforeAll(async () => {
    assertLocalOnly(TEST_DATABASE_URL!);
    ({ prisma } = await import("@/lib/prisma"));
    ({ POST } = await import("./route"));
    sortOrderReservationModule = await import("@/lib/upload/sortOrderReservation");
    // Defensive cleanup for this run's own namespace only (should already be
    // empty given the random UUID, but costs nothing to be sure).
    await cleanupNamespace(RUN_NS);
  });

  afterAll(async () => {
    // Always disconnect, even if cleanup or the residual-count assertion
    // below throws — otherwise a failed run leaks the pool connection. A
    // disconnect failure must not mask the original cleanup/assertion error,
    // so it's caught separately and only surfaced when there was no prior
    // error to report.
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
    // B3c-2: 未解決の barrier を必ず release して suite の hang を防ぎ、
    // knob を毎 test reset する(test 順序非依存)。
    for (const release of pendingReleases.splice(0)) release();
    sessionGuardBarrier = null;
    uploadHoldBarrier = null;

    // Cleans up exactly the rows this test case created. If the test failed
    // before reaching this point, afterAll's namespace-wide sweep still
    // catches it.
    if (currentCaseWorkspaceId) {
      await cleanupNamespace(currentCaseWorkspaceId);
      currentCaseWorkspaceId = null;
    }
    uploadCalls.length = 0;
  });

  async function makeSession(caseLabel: string): Promise<{ workspaceId: string; sessionId: string }> {
    const workspaceId = `${RUN_NS}w_${caseLabel}_`;
    const sessionId = `${workspaceId}s`;
    const userId = `${workspaceId}user`; // namespaced — no fixed cross-case/cross-file userId
    currentCaseWorkspaceId = workspaceId; // scoped strictly to this case (still under RUN_NS)
    currentUserId = userId; // the @/lib/auth mock returns this for the route's getCurrentUser() calls
    await prisma.workspace.create({ data: { id: workspaceId, name: "t", slug: workspaceId } });
    await prisma.workspaceMember.create({ data: { workspaceId, userId, role: "owner" } });
    await prisma.uploadSession.create({ data: { id: sessionId, workspaceId, userId, status: "ACTIVE" } });
    return { workspaceId, sessionId };
  }

  // Minimal valid JPEG per validateImage.ts's magic-byte check (FF D8 FF …).
  function jpegBytes(payload = "x".repeat(64)) {
    return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(payload)]);
  }

  function buildFormData(sessionId: string, bytes: Buffer, name = "test.jpg") {
    const fd = new FormData();
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    fd.append("sessionId", sessionId);
    fd.append("clientFileHash", hash);
    fd.append("original", new File([new Uint8Array(bytes)], name, { type: "image/jpeg" }));
    fd.append("originalName", name);
    return fd;
  }

  async function postUpload(sessionId: string, bytes = jpegBytes()) {
    const fd = buildFormData(sessionId, bytes);
    const req = new Request("http://localhost/api/uploads/items", { method: "POST", body: fd });
    return POST(req as unknown as Parameters<typeof POST>[0]);
  }

  it("1) counter 0 のsessionへupload → item.sortOrder=0、counter=1", async () => {
    const { sessionId } = await makeSession("c1");
    const res = await postUpload(sessionId);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.item.sortOrder).toBe(0);

    const session = await prisma.uploadSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.nextUploadSortOrder).toBe(1); // counter+1のみ(trigger二重incrementなし)
  });

  it("2) counter 10 のsessionへupload → item.sortOrder=10、counter=11", async () => {
    const { sessionId } = await makeSession("c2");
    await prisma.uploadSession.update({ where: { id: sessionId }, data: { nextUploadSortOrder: 10 } });

    const res = await postUpload(sessionId);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.item.sortOrder).toBe(10);

    const session = await prisma.uploadSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.nextUploadSortOrder).toBe(11);
  });

  it("3) 同一sessionへの並行uploadはsortOrder重複なし・連続値になる", async () => {
    const { sessionId } = await makeSession("c3");

    const CONCURRENCY = 5;
    const responses = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) => postUpload(sessionId, jpegBytes(`payload-${i}`))),
    );
    for (const r of responses) expect(r.status).toBe(201);
    const jsons = await Promise.all(responses.map((r) => r.json()));
    const sortOrders = jsons.map((j) => j.data.item.sortOrder).sort((a: number, b: number) => a - b);
    expect(sortOrders).toEqual(Array.from({ length: CONCURRENCY }, (_, i) => i));

    const session = await prisma.uploadSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.nextUploadSortOrder).toBe(CONCURRENCY);

    const items = await prisma.uploadItem.findMany({ where: { sessionId } });
    expect(items).toHaveLength(CONCURRENCY);
    expect(new Set(items.map((i) => i.sortOrder)).size).toBe(CONCURRENCY); // 重複なし
  });

  it("4) UploadItem create失敗時はtransaction全体がrollbackされ、counterも不変、Storage PUTは未実行", async () => {
    const { sessionId } = await makeSession("c4");
    __forceNextUploadItemCreateFailure();

    await expect(postUpload(sessionId)).rejects.toThrow();

    const session = await prisma.uploadSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.nextUploadSortOrder).toBe(0); // reservationごとrollback
    const items = await prisma.uploadItem.count({ where: { sessionId } });
    expect(items).toBe(0);
    expect(uploadCalls).toHaveLength(0); // Storage PUTに到達していない
  });

  it("5) reservation失敗(session不存在相当)時はUploadItem未作成・Storage PUT未実行", async () => {
    const { sessionId } = await makeSession("c5");
    const spy = vi
      .spyOn(sortOrderReservationModule, "reserveSortOrder")
      .mockResolvedValueOnce({ ok: false, reason: "SESSION_NOT_FOUND" });

    const res = await postUpload(sessionId);
    spy.mockRestore();

    expect(res.status).toBe(404); // 既存のsession不存在時と同じcontract
    const items = await prisma.uploadItem.count({ where: { sessionId } });
    expect(items).toBe(0);
    expect(uploadCalls).toHaveLength(0);
  });

  it("6) 旧方式相当の直接INSERT(sortOrder飛び値)後もtriggerがcounterを必要値まで進める", async () => {
    const { workspaceId, sessionId } = await makeSession("c6");
    await postUpload(sessionId); // counter: 0 -> 1, item sortOrder=0

    // 旧 multipart route と同じ経路を模した直接 INSERT(reserveSortOrderを経由しない)
    await prisma.uploadItem.create({
      data: {
        id: `${workspaceId}legacy-item`,
        workspaceId,
        sessionId,
        sortOrder: 7,
        originalName: "legacy.jpg",
        originalExt: "jpg",
        mimeType: "image/jpeg",
        fileSizeBytes: 10,
        fileHash: "legacyhash",
        tempStoragePath: `${workspaceId}/uploads/${sessionId}/legacy-item/original.jpg`,
      },
    });

    const session = await prisma.uploadSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.nextUploadSortOrder).toBe(8); // trigger が 7+1 まで進める

    // 以後のhelper呼出しは8から継続する(重複しない)
    const res = await postUpload(sessionId);
    const json = await res.json();
    expect(json.data.item.sortOrder).toBe(8);
  });

  it("7) response shape / status は既存契約のまま(201・item・signedUrls)", async () => {
    const { workspaceId, sessionId } = await makeSession("c7");
    const res = await postUpload(sessionId);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.item).toMatchObject({ sessionId, workspaceId, uploadStatus: "READY" });
    expect(json.data.signedUrls).toHaveProperty("thumbnail");
    expect(json.data.signedUrls).toHaveProperty("preview");
    expect(json.data.signedUrls).toHaveProperty("original");
    expect(uploadCalls.length).toBeGreaterThan(0); // 正常系ではStorage PUTに到達している
  });

  // -------------------------------------------------------------------------
  // Phase 10-43-B3c-2: session cleanup interlock
  // -------------------------------------------------------------------------
  describe("cleanup interlock (B3c-2)", () => {
    const LEASE_TOKEN = "b3c2-test-cleanup-token-1234567890ab";
    const FIXED_MESSAGE = "This session is being cleaned up. Please retry shortly.";

    async function setLease(sessionId: string, until: Date) {
      // Extension を通らない raw SQL(cleanup claim CAS 相当の注入)。
      await prisma.$executeRaw`
        UPDATE "upload_sessions"
           SET "cleanup_lease_until" = ${until},
               "cleanup_attempt_token" = ${LEASE_TOKEN}
         WHERE "id" = ${sessionId}`;
    }

    async function sessionRow(sessionId: string) {
      return prisma.uploadSession.findUniqueOrThrow({ where: { id: sessionId } });
    }

    it("i1) initial guard: active cleanup lease → 409 SESSION_CLEANUP_IN_PROGRESS(固定文)", async () => {
      const { sessionId } = await makeSession("i1");
      await setLease(sessionId, new Date(Date.now() + 60_000));

      const res = await postUpload(sessionId);
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error.code).toBe("SESSION_CLEANUP_IN_PROGRESS");
      expect(json.error.message).toBe(FIXED_MESSAGE);
    });

    it("i2) initial guard: active lease 中は item 0・counter 不変・Storage PUT 0", async () => {
      const { sessionId } = await makeSession("i2");
      await setLease(sessionId, new Date(Date.now() + 60_000));

      const res = await postUpload(sessionId);
      expect(res.status).toBe(409);
      expect(await prisma.uploadItem.count({ where: { sessionId } })).toBe(0);
      expect((await sessionRow(sessionId)).nextUploadSortOrder).toBe(0);
      expect(uploadCalls).toHaveLength(0);
    });

    it("i3) initial guard: response へ lease timestamp / attempt token を露出しない", async () => {
      const { sessionId } = await makeSession("i3");
      const until = new Date(Date.now() + 60_000);
      await setLease(sessionId, until);

      const res = await postUpload(sessionId);
      expect(res.status).toBe(409);
      const text = JSON.stringify(await res.json());
      expect(text).not.toContain(LEASE_TOKEN);
      expect(text).not.toContain(until.toISOString());
      expect(text).not.toContain("cleanupLeaseUntil");
      expect(text).not.toContain("cleanupAttemptToken");
    });

    it("i4) stale(失効済み) cleanup lease は upload を拒否しない(201)", async () => {
      const { sessionId } = await makeSession("i4");
      await setLease(sessionId, new Date(Date.now() - 1_000));

      const res = await postUpload(sessionId);
      expect(res.status).toBe(201);
      expect(await prisma.uploadItem.count({ where: { sessionId } })).toBe(1);
    });

    it("i5) race: initial read 通過後・tx guard 直前に claim 取得 → 409(固定契約)", async () => {
      const { sessionId } = await makeSession("i5");
      const { reached, release } = __armSessionGuardBarrier();

      const responsePromise = postUpload(sessionId);
      try {
        await withTimeout(reached, 3_000, "session guard barrier");
        // guard query は未実行(row lock 未取得)なので、別 connection の注入は進む。
        await setLease(sessionId, new Date(Date.now() + 60_000));
      } finally {
        release();
      }

      const res = await withTimeout(responsePromise, 5_000, "race response");
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error.code).toBe("SESSION_CLEANUP_IN_PROGRESS");
      expect(json.error.message).toBe(FIXED_MESSAGE);
    });

    it("i6) race 時は item 0・counter rollback(不変)・Storage PUT 0", async () => {
      const { sessionId } = await makeSession("i6");
      const { reached, release } = __armSessionGuardBarrier();

      const responsePromise = postUpload(sessionId);
      try {
        await withTimeout(reached, 3_000, "session guard barrier");
        await setLease(sessionId, new Date(Date.now() + 60_000));
      } finally {
        release();
      }
      const res = await withTimeout(responsePromise, 5_000, "race response");

      expect(res.status).toBe(409);
      expect(await prisma.uploadItem.count({ where: { sessionId } })).toBe(0);
      expect((await sessionRow(sessionId)).nextUploadSortOrder).toBe(0); // 予約未実行/rollback
      expect(uploadCalls).toHaveLength(0);
    });

    it("i7) race: guard 直前に status が ABANDONED 化 → 既存 status validation 契約(400)", async () => {
      const { sessionId } = await makeSession("i7");
      const { reached, release } = __armSessionGuardBarrier();

      const responsePromise = postUpload(sessionId);
      try {
        await withTimeout(reached, 3_000, "session guard barrier");
        await prisma.$executeRaw`
          UPDATE "upload_sessions" SET "status" = 'ABANDONED' WHERE "id" = ${sessionId}`;
      } finally {
        release();
      }
      const res = await withTimeout(responsePromise, 5_000, "race response");

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe("VALIDATION_ERROR");
      expect(json.error.message).toContain("Session status is 'ABANDONED'");
      expect(await prisma.uploadItem.count({ where: { sessionId } })).toBe(0);
      expect(uploadCalls).toHaveLength(0);
    });

    it("i8) upload winner: 最初の Storage PUT 完了前に UPLOADING row + server 生成 temp paths が確定済み", async () => {
      const { workspaceId, sessionId } = await makeSession("i8");
      const { reached, release } = __armUploadHold();

      const responsePromise = postUpload(sessionId);
      let heldItem: { uploadStatus: string; tempStoragePath: string; tempThumbnailPath: string | null; tempPreviewPath: string | null } | null = null;
      try {
        await withTimeout(reached, 3_000, "storage upload hold");
        // PUT 未完了(uploadCalls は完了時に記録される)の時点で row が観測できる =
        // transaction が Storage I/O より先に commit 済み(marker 順序の証明)。
        expect(uploadCalls).toHaveLength(0);
        heldItem = await prisma.uploadItem.findFirst({
          where: { sessionId },
          select: { uploadStatus: true, tempStoragePath: true, tempThumbnailPath: true, tempPreviewPath: true },
        });
      } finally {
        release();
      }

      expect(heldItem).not.toBeNull();
      expect(heldItem!.uploadStatus).toBe("UPLOADING");
      expect(heldItem!.tempStoragePath).toContain(`${workspaceId}/uploads/${sessionId}/`);
      expect(heldItem!.tempThumbnailPath).toContain(`${workspaceId}/uploads/${sessionId}/`);
      expect(heldItem!.tempPreviewPath).toContain(`${workspaceId}/uploads/${sessionId}/`);

      const res = await withTimeout(responsePromise, 5_000, "held upload response");
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.item.uploadStatus).toBe("READY");
    });

    it("i9) initial guard は tx より前に判定される(active lease 時は tx guard へ到達しない)", async () => {
      const { sessionId } = await makeSession("i9");
      await setLease(sessionId, new Date(Date.now() + 60_000));
      const { reached, release } = __armSessionGuardBarrier();

      // initial guard が削除されると request は tx guard(barrier)へ到達して
      // hold され、この await が timeout する(= mutation 検出)。
      const res = await withTimeout(postUpload(sessionId), 3_000, "initial-guard fast path");
      expect(res.status).toBe(409);

      // response 確定後も barrier は未到達のまま = tx を開始していない。
      const reachedFirst = await Promise.race([reached.then(() => true), Promise.resolve(false)]);
      expect(reachedFirst).toBe(false);
      release();
    });
  });
});

describe("route source no longer uses aggregate MAX(sortOrder)+1", () => {
  it("10) 旧 aggregate ベースの sortOrder 計算がroute内に存在しない", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(new URL("./route.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/_max:\s*{\s*sortOrder:\s*true\s*}/);
    expect(source).not.toMatch(/uploadItem\.aggregate/);
    expect(source).toContain("reserveSortOrder");
  });
});

describe("B3c-2 static contract (items route)", () => {
  it("s1) maxDuration=60 を明示 export している", async () => {
    const routeModule = await import("./route");
    expect(routeModule.maxDuration).toBe(60);
    const fs = await import("node:fs");
    const source = fs.readFileSync(new URL("./route.ts", import.meta.url), "utf8");
    expect(source).toContain("export const maxDuration = 60;");
    expect(source).toContain('export const dynamic = "force-dynamic";'); // 既存契約維持
  });

  it("s2) tx guard は workspace/user/status/cleanup lease を条件に持ち、claim writer を含まない", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(new URL("./route.ts", import.meta.url), "utf8");

    // transaction guard の必須条件(fixtureで動的にも固定するが、条件セットは source で pin する)
    const guardMatch = source.match(/tx\.uploadSession\.updateMany\(\{[\s\S]*?\}\);/);
    expect(guardMatch).not.toBeNull();
    const guard = guardMatch![0];
    expect(guard).toContain("workspaceId: session.workspaceId");
    expect(guard).toContain("userId: user.id");
    expect(guard).toContain('status: "ACTIVE"');
    expect(guard).toContain("cleanupLeaseUntil: null");
    expect(guard).toContain("cleanupLeaseUntil: { lte: guardNow }");

    // B3c-2 は lease を読む・guard するだけ — claim writer を追加しない(dormant)
    expect(source).not.toContain("decideClaim");
    expect(source).not.toContain("ownsClaim");
    expect(source).not.toContain("cleanupAttemptToken");
  });
});
