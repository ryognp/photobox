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

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { reserveSortOrder } from "./sortOrderReservation";

const TEST_DATABASE_URL = process.env.PHOTOBOX_TEST_DATABASE_URL;

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

  beforeAll(() => {
    assertLocalOnly(TEST_DATABASE_URL!);
    const adapter = new PrismaPg({ connectionString: TEST_DATABASE_URL! });
    prisma = new PrismaClient({ adapter });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function makeWorkspaceAndSession(sessionId: string) {
    const workspaceId = `w_${sessionId}`;
    await prisma.workspace.create({ data: { id: workspaceId, name: "t", slug: workspaceId } });
    await prisma.uploadSession.create({
      data: { id: sessionId, workspaceId, userId: "u1", status: "ACTIVE" },
    });
    return workspaceId;
  }

  beforeEach(async () => {
    // 前回テストの行を掃除する(session/workspace は全テストで固有 id を使うが、
    // 再実行時の重複を避けるため念のため)。
    await prisma.uploadItem.deleteMany({});
    await prisma.uploadSession.deleteMany({});
    await prisma.workspace.deleteMany({});
  });

  it("1) counter 0 から呼ぶと予約値0、DB counter は1になる", async () => {
    await makeWorkspaceAndSession("s1");
    const result = await reserveSortOrder(prisma, "s1");
    expect(result).toEqual({ ok: true, sortOrder: 0 });

    const session = await prisma.uploadSession.findUniqueOrThrow({ where: { id: "s1" } });
    expect(session.nextUploadSortOrder).toBe(1);
  });

  it("2) counter 10 から呼ぶと予約値10、DB counter は11になる", async () => {
    await makeWorkspaceAndSession("s2");
    await prisma.uploadSession.update({ where: { id: "s2" }, data: { nextUploadSortOrder: 10 } });

    const result = await reserveSortOrder(prisma, "s2");
    expect(result).toEqual({ ok: true, sortOrder: 10 });

    const session = await prisma.uploadSession.findUniqueOrThrow({ where: { id: "s2" } });
    expect(session.nextUploadSortOrder).toBe(11);
  });

  it("3) 同一sessionへの並行呼出しは重複せず連続した値になり、counterは呼出件数分だけ増える", async () => {
    await makeWorkspaceAndSession("s3");

    const CONCURRENCY = 8;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => reserveSortOrder(prisma, "s3")),
    );

    const values = results.map((r) => (r.ok ? r.sortOrder : null)).sort((a, b) => (a ?? -1) - (b ?? -1));
    expect(values).toEqual(Array.from({ length: CONCURRENCY }, (_, i) => i)); // 0..7 の連続値、重複なし

    const session = await prisma.uploadSession.findUniqueOrThrow({ where: { id: "s3" } });
    expect(session.nextUploadSortOrder).toBe(CONCURRENCY);
  });

  it("4) 存在しない session は SESSION_NOT_FOUND を返し、他sessionのcounterを変更しない", async () => {
    await makeWorkspaceAndSession("s4_untouched");
    const before = await prisma.uploadSession.findUniqueOrThrow({ where: { id: "s4_untouched" } });

    const result = await reserveSortOrder(prisma, "s4_does_not_exist");
    expect(result).toEqual({ ok: false, reason: "SESSION_NOT_FOUND" });

    const after = await prisma.uploadSession.findUniqueOrThrow({ where: { id: "s4_untouched" } });
    expect(after.nextUploadSortOrder).toBe(before.nextUploadSortOrder);
  });

  it("5) Prisma の transaction client 経由で実行できる", async () => {
    await makeWorkspaceAndSession("s5");

    const result = await prisma.$transaction((tx) => reserveSortOrder(tx, "s5"));
    expect(result).toEqual({ ok: true, sortOrder: 0 });
  });

  it("6) rollback される transaction 内で呼ぶと、counter の更新も rollback される", async () => {
    await makeWorkspaceAndSession("s6");

    await expect(
      prisma.$transaction(async (tx) => {
        const result = await reserveSortOrder(tx, "s6");
        expect(result).toEqual({ ok: true, sortOrder: 0 });
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");

    const session = await prisma.uploadSession.findUniqueOrThrow({ where: { id: "s6" } });
    expect(session.nextUploadSortOrder).toBe(0); // rollback されているので増えていない
  });

  it("7) helper 自体は旧 UploadItem INSERT 用 trigger を発火させない(UploadItem を作らない)", async () => {
    await makeWorkspaceAndSession("s7");
    await reserveSortOrder(prisma, "s7");

    const itemCount = await prisma.uploadItem.count({ where: { sessionId: "s7" } });
    expect(itemCount).toBe(0);
  });

  it("8) helper呼出し後、旧方式の直接INSERTがtriggerでcounterを後退させない", async () => {
    const workspaceId = await makeWorkspaceAndSession("s8");

    // helper で 3 回予約する(counter は 0,1,2 を返し、DB counter は 3 になる)
    const r1 = await reserveSortOrder(prisma, "s8");
    const r2 = await reserveSortOrder(prisma, "s8");
    const r3 = await reserveSortOrder(prisma, "s8");
    expect([r1, r2, r3].map((r) => (r.ok ? r.sortOrder : null))).toEqual([0, 1, 2]);

    // 旧 multipart route と同じ経路(直接 INSERT、sort_order は小さい値)を模す
    await prisma.uploadItem.create({
      data: {
        id: "legacy-item",
        workspaceId,
        sessionId: "s8",
        sortOrder: 1, // helper がすでに予約した範囲内の値(旧経路は helper を知らない)
        originalName: "legacy.jpg",
        originalExt: "jpg",
        mimeType: "image/jpeg",
        fileSizeBytes: 10,
        fileHash: "legacyhash",
        tempStoragePath: `${workspaceId}/uploads/s8/legacy-item/original.jpg`,
      },
    });

    const session = await prisma.uploadSession.findUniqueOrThrow({ where: { id: "s8" } });
    expect(session.nextUploadSortOrder).toBe(3); // trigger が counter を後退させていない
  });
});
