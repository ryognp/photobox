// Phase 10-43-B1 review fix: integration test for the production
// `reserveSortOrder()` function itself (not a re-implementation of its SQL).
//
// This test needs a real Postgres with the B1 migration applied. It is opt-in
// via PHOTOBOX_TEST_DATABASE_URL (isolated, never the app's own env files) so
// a normal `vitest run` without that variable set skips this file instead of
// failing — consistent with the project's stance of not running heavy
// integration tests by default (see photobox-workflow skill).
//
// To run: point PHOTOBOX_TEST_DATABASE_URL at an isolated local Postgres
// (localhost/127.0.0.1 only) that already has the B1 migration applied, e.g.
//   PHOTOBOX_TEST_DATABASE_URL="postgresql://postgres:pw@127.0.0.1:PORT/db" npx vitest run src/lib/upload/sortOrderReservation.integration.test.ts
//
// Fixture isolation (Phase 10-43-B1.1 review fix): this file shares its DB
// with src/app/api/uploads/items/route.integration.test.ts. Under Vitest's
// default file parallelism both files' `beforeEach` used to run
// `deleteMany({})` on the whole table, wiping each other's fixtures mid-run.
// Every row this file creates is now namespaced under a per-process,
// per-file-load random prefix (RUN_NS), and all cleanup queries are scoped to
// that prefix — never an unscoped table-wide delete.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import crypto from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { reserveSortOrder } from "./sortOrderReservation";

const TEST_DATABASE_URL = process.env.PHOTOBOX_TEST_DATABASE_URL;

// Unique per test-process + per file load, so concurrent Vitest file workers
// (and even repeated invocations against the same DB) never collide.
const RUN_NS = `b1_reservation_${process.pid}_${crypto.randomUUID()}_`;

function assertLocalOnly(url: string) {
  const parsed = new URL(url);
  if (!["localhost", "127.0.0.1"].includes(parsed.hostname)) {
    throw new Error(
      `PHOTOBOX_TEST_DATABASE_URL must point at localhost/127.0.0.1 only, got hostname "${parsed.hostname}"`,
    );
  }
}

describe.skipIf(!TEST_DATABASE_URL)("reserveSortOrder (isolated Postgres integration)", () => {
  let prisma: PrismaClient;
  let currentCaseWorkspaceId: string | null = null;

  // Namespace-scoped cleanup only — never an unscoped deleteMany({}). FK
  // order: UploadItem -> UploadSession -> Workspace (WorkspaceMember unused
  // in this file's fixtures).
  async function cleanupNamespace(prefix: string) {
    await prisma.uploadItem.deleteMany({ where: { workspaceId: { startsWith: prefix } } });
    await prisma.uploadSession.deleteMany({ where: { workspaceId: { startsWith: prefix } } });
    await prisma.workspace.deleteMany({ where: { id: { startsWith: prefix } } });
  }

  beforeAll(async () => {
    assertLocalOnly(TEST_DATABASE_URL!);
    const adapter = new PrismaPg({ connectionString: TEST_DATABASE_URL! });
    prisma = new PrismaClient({ adapter });
    // Defensive cleanup for this run's own namespace only (should already be
    // empty given the random UUID, but costs nothing to be sure).
    await cleanupNamespace(RUN_NS);
  });

  afterAll(async () => {
    const remaining = await cleanupAndCount(RUN_NS);
    expect(remaining).toBe(0);
    await prisma.$disconnect();
  });

  async function cleanupAndCount(prefix: string) {
    await cleanupNamespace(prefix);
    const [items, sessions, workspaces] = await Promise.all([
      prisma.uploadItem.count({ where: { workspaceId: { startsWith: prefix } } }),
      prisma.uploadSession.count({ where: { workspaceId: { startsWith: prefix } } }),
      prisma.workspace.count({ where: { id: { startsWith: prefix } } }),
    ]);
    return items + sessions + workspaces;
  }

  afterEach(async () => {
    // Cleans up exactly the rows this test case created. If the test failed
    // before reaching this point, afterAll's namespace-wide sweep still
    // catches it.
    if (currentCaseWorkspaceId) {
      await cleanupNamespace(currentCaseWorkspaceId);
      currentCaseWorkspaceId = null;
    }
  });

  async function makeWorkspaceAndSession(caseLabel: string): Promise<{ workspaceId: string; sessionId: string }> {
    const workspaceId = `${RUN_NS}w_${caseLabel}_`;
    const sessionId = `${workspaceId}s`;
    currentCaseWorkspaceId = workspaceId; // scoped strictly to this case (still under RUN_NS)
    await prisma.workspace.create({ data: { id: workspaceId, name: "t", slug: workspaceId } });
    await prisma.uploadSession.create({
      data: { id: sessionId, workspaceId, userId: "u1", status: "ACTIVE" },
    });
    return { workspaceId, sessionId };
  }

  it("1) counter 0 から呼ぶと予約値0、DB counter は1になる", async () => {
    const { sessionId } = await makeWorkspaceAndSession("c1");
    const result = await reserveSortOrder(prisma, sessionId);
    expect(result).toEqual({ ok: true, sortOrder: 0 });

    const session = await prisma.uploadSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.nextUploadSortOrder).toBe(1);
  });

  it("2) counter 10 から呼ぶと予約値10、DB counter は11になる", async () => {
    const { sessionId } = await makeWorkspaceAndSession("c2");
    await prisma.uploadSession.update({ where: { id: sessionId }, data: { nextUploadSortOrder: 10 } });

    const result = await reserveSortOrder(prisma, sessionId);
    expect(result).toEqual({ ok: true, sortOrder: 10 });

    const session = await prisma.uploadSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.nextUploadSortOrder).toBe(11);
  });

  it("3) 同一sessionへの並行呼出しは重複せず連続した値になり、counterは呼出件数分だけ増える", async () => {
    const { sessionId } = await makeWorkspaceAndSession("c3");

    const CONCURRENCY = 8;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => reserveSortOrder(prisma, sessionId)),
    );

    const values = results.map((r) => (r.ok ? r.sortOrder : null)).sort((a, b) => (a ?? -1) - (b ?? -1));
    expect(values).toEqual(Array.from({ length: CONCURRENCY }, (_, i) => i)); // 0..7 の連続値、重複なし

    const session = await prisma.uploadSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.nextUploadSortOrder).toBe(CONCURRENCY);
  });

  it("4) 存在しない session は SESSION_NOT_FOUND を返し、他sessionのcounterを変更しない", async () => {
    const { workspaceId, sessionId } = await makeWorkspaceAndSession("c4");
    const before = await prisma.uploadSession.findUniqueOrThrow({ where: { id: sessionId } });

    const result = await reserveSortOrder(prisma, `${workspaceId}does_not_exist`);
    expect(result).toEqual({ ok: false, reason: "SESSION_NOT_FOUND" });

    const after = await prisma.uploadSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(after.nextUploadSortOrder).toBe(before.nextUploadSortOrder);
  });

  it("5) Prisma の transaction client 経由で実行できる", async () => {
    const { sessionId } = await makeWorkspaceAndSession("c5");

    const result = await prisma.$transaction((tx) => reserveSortOrder(tx, sessionId));
    expect(result).toEqual({ ok: true, sortOrder: 0 });
  });

  it("6) rollback される transaction 内で呼ぶと、counter の更新も rollback される", async () => {
    const { sessionId } = await makeWorkspaceAndSession("c6");

    await expect(
      prisma.$transaction(async (tx) => {
        const result = await reserveSortOrder(tx, sessionId);
        expect(result).toEqual({ ok: true, sortOrder: 0 });
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");

    const session = await prisma.uploadSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.nextUploadSortOrder).toBe(0); // rollback されているので増えていない
  });

  it("7) helper 自体は旧 UploadItem INSERT 用 trigger を発火させない(UploadItem を作らない)", async () => {
    const { sessionId } = await makeWorkspaceAndSession("c7");
    await reserveSortOrder(prisma, sessionId);

    const itemCount = await prisma.uploadItem.count({ where: { sessionId } });
    expect(itemCount).toBe(0);
  });

  it("8) helper呼出し後、旧方式の直接INSERTがtriggerでcounterを後退させない", async () => {
    const { workspaceId, sessionId } = await makeWorkspaceAndSession("c8");

    // helper で 3 回予約する(counter は 0,1,2 を返し、DB counter は 3 になる)
    const r1 = await reserveSortOrder(prisma, sessionId);
    const r2 = await reserveSortOrder(prisma, sessionId);
    const r3 = await reserveSortOrder(prisma, sessionId);
    expect([r1, r2, r3].map((r) => (r.ok ? r.sortOrder : null))).toEqual([0, 1, 2]);

    // 旧 multipart route と同じ経路(直接 INSERT、sort_order は小さい値)を模す
    await prisma.uploadItem.create({
      data: {
        id: `${workspaceId}legacy-item`,
        workspaceId,
        sessionId,
        sortOrder: 1, // helper がすでに予約した範囲内の値(旧経路は helper を知らない)
        originalName: "legacy.jpg",
        originalExt: "jpg",
        mimeType: "image/jpeg",
        fileSizeBytes: 10,
        fileHash: "legacyhash",
        tempStoragePath: `${workspaceId}/uploads/${sessionId}/legacy-item/original.jpg`,
      },
    });

    const session = await prisma.uploadSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.nextUploadSortOrder).toBe(3); // trigger が counter を後退させていない
  });
});
