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

// Storage must never be touched for real in this test — every call succeeds
// deterministically so we can assert purely on DB state and on whether
// Storage was invoked at all (never() checks for the rollback/failure cases).
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    storage: {
      from: () => ({
        upload: async (path: string) => {
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
