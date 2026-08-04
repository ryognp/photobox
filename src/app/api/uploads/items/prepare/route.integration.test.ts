// Phase 10-43-B2: integration test for POST /api/uploads/items/prepare.
// Drives the real route handler against an isolated local Postgres. Supabase
// (signed upload URL issuance) and auth are mocked — the token issuance path
// must never touch a real Supabase project from a test.
//
// Opt-in via PHOTOBOX_TEST_DATABASE_URL (isolated, localhost/127.0.0.1 only);
// skips when unset so a plain `vitest run` needs no live DB.
//
// Fixture isolation follows the B1.1 discipline: every row this file creates is
// namespaced under a per-process, per-file-load prefix (RUN_NS) and all cleanup
// is scoped to that prefix — never an unscoped table-wide delete.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";

const TEST_DATABASE_URL = process.env.PHOTOBOX_TEST_DATABASE_URL;

const RUN_NS = `b2_prepare_${process.pid}_${crypto.randomUUID().replace(/-/g, "")}_`;

function assertLocalOnly(url: string) {
  const parsed = new URL(url);
  if (!["localhost", "127.0.0.1"].includes(parsed.hostname)) {
    throw new Error(`PHOTOBOX_TEST_DATABASE_URL must point at localhost/127.0.0.1 only, got hostname "${parsed.hostname}"`);
  }
}

let currentUserId = `${RUN_NS}unset`;

vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => (currentUserId.endsWith("unset") ? null : { id: currentUserId, email: "t@example.com" }),
}));

// Supabase signed upload URL issuance. Controlled per test via these knobs so
// we can exercise success, provider failure, and path-mismatch defences.
let signedUrlBehaviour: "ok" | "error" | "empty_token" | "path_mismatch" = "ok";
const createSignedUploadUrlCalls: Array<{ path: string; upsert: unknown }> = [];

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    storage: {
      from: () => ({
        createSignedUploadUrl: async (path: string, opts?: { upsert?: boolean }) => {
          createSignedUploadUrlCalls.push({ path, upsert: opts?.upsert });
          if (signedUrlBehaviour === "error") return { data: null, error: { message: "provider exploded", statusCode: "500" } };
          if (signedUrlBehaviour === "empty_token") return { data: { signedUrl: "https://x/y", token: "", path }, error: null };
          if (signedUrlBehaviour === "path_mismatch") {
            return { data: { signedUrl: "https://x/y", token: "tok", path: `${path}-tampered` }, error: null };
          }
          return { data: { signedUrl: "https://example.test/upload", token: `token-for-${path}`, path }, error: null };
        },
      }),
    },
  },
}));

// このfile全体は direct upload gate が開いている前提のテスト。gate自体の
// 閉塞挙動は test 23 が vi.doMock + resetModules で個別に検証する。
vi.mock("@/lib/upload/directUploadFeature", () => ({
  readDirectUploadEnabledFlag: () => true,
}));

vi.mock("@/lib/prisma", async () => {
  if (!TEST_DATABASE_URL) return { prisma: null };
  const { PrismaClient } = await import("@/generated/prisma/client");
  const adapter = new PrismaPg({ connectionString: TEST_DATABASE_URL });
  return { prisma: new PrismaClient({ adapter }) };
});

describe.skipIf(!TEST_DATABASE_URL)("POST /api/uploads/items/prepare (isolated Postgres integration)", () => {
  let prisma: import("@/generated/prisma/client").PrismaClient;
  let POST: (typeof import("./route"))["POST"];
  let currentCaseWorkspaceId: string | null = null;

  async function cleanupNamespace(prefix: string) {
    await prisma.uploadIntent.deleteMany({ where: { workspaceId: { startsWith: prefix } } });
    await prisma.uploadItem.deleteMany({ where: { workspaceId: { startsWith: prefix } } });
    await prisma.uploadSession.deleteMany({ where: { workspaceId: { startsWith: prefix } } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: { startsWith: prefix } } });
    await prisma.workspace.deleteMany({ where: { id: { startsWith: prefix } } });
  }

  async function countNamespace(prefix: string) {
    const [intents, items, sessions, members, workspaces] = await Promise.all([
      prisma.uploadIntent.count({ where: { workspaceId: { startsWith: prefix } } }),
      prisma.uploadItem.count({ where: { workspaceId: { startsWith: prefix } } }),
      prisma.uploadSession.count({ where: { workspaceId: { startsWith: prefix } } }),
      prisma.workspaceMember.count({ where: { workspaceId: { startsWith: prefix } } }),
      prisma.workspace.count({ where: { id: { startsWith: prefix } } }),
    ]);
    return intents + items + sessions + members + workspaces;
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
      expect(await countNamespace(RUN_NS)).toBe(0);
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
    if (currentCaseWorkspaceId) {
      await cleanupNamespace(currentCaseWorkspaceId);
      currentCaseWorkspaceId = null;
    }
    createSignedUploadUrlCalls.length = 0;
    signedUrlBehaviour = "ok";
  });

  async function makeSession(caseLabel: string, over: { status?: "ACTIVE" | "PREVIEWING" | "ABANDONED" | "COMMITTED"; cleanupLeaseUntil?: Date | null } = {}) {
    const workspaceId = `${RUN_NS}w${caseLabel}`;
    const sessionId = `${workspaceId}s`;
    const userId = `${workspaceId}u`;
    currentCaseWorkspaceId = workspaceId;
    currentUserId = userId;
    await prisma.workspace.create({ data: { id: workspaceId, name: "t", slug: workspaceId } });
    await prisma.workspaceMember.create({ data: { workspaceId, userId, role: "owner" } });
    await prisma.uploadSession.create({
      data: {
        id: sessionId,
        workspaceId,
        userId,
        status: over.status ?? "ACTIVE",
        cleanupLeaseUntil: over.cleanupLeaseUntil ?? null,
      },
    });
    return { workspaceId, sessionId, userId };
  }

  function payload(sessionId: string, over: Record<string, unknown> = {}) {
    return {
      sessionId,
      clientUploadId: crypto.randomUUID(),
      originalName: "photo.jpg",
      declaredSizeBytes: 1024,
      declaredMimeType: "image/jpeg",
      clientFileHash: "a".repeat(64),
      ...over,
    };
  }

  async function post(body: unknown, contentType = "application/json") {
    const req = new Request("http://localhost/api/uploads/items/prepare", {
      method: "POST",
      headers: contentType ? { "content-type": contentType } : {},
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return POST(req as unknown as Parameters<typeof POST>[0]);
  }

  // ---- happy path -------------------------------------------------------

  it("1) 新規intentは201・no-store・token/pathを返し、sortOrderを1つ予約する", async () => {
    const { sessionId, workspaceId } = await makeSession("c1");
    const res = await post(payload(sessionId));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const json = await res.json();
    expect(json.data.reservedSortOrder).toBe(0);
    expect(json.data.alreadyFinalized).toBe(false);
    expect(json.data.upload.bucket).toBe("photobox-private");
    expect(json.data.upload.path).toBe(`${workspaceId}/upload-intents/${sessionId}/${json.data.intentId}/original`);
    expect(json.data.upload.token).toBeTruthy();
    expect(new Date(json.data.upload.expiresAt).getTime() - Date.now()).toBeGreaterThan(7_000_000);

    // upsert:false で発行されている
    expect(createSignedUploadUrlCalls).toHaveLength(1);
    expect(createSignedUploadUrlCalls[0].upsert).toBe(false);

    const intent = await prisma.uploadIntent.findUniqueOrThrow({ where: { id: json.data.intentId } });
    expect(intent.status).toBe("PREPARED");
    expect(intent.reservedSortOrder).toBe(0);
    expect(intent.canonicalOriginalPath).toBeNull();
    expect(intent.uploadItemId).toBeNull();
    expect(intent.signedUploadIssuedAt).not.toBeNull();
    expect(intent.signedUploadExpiresAt).not.toBeNull();
    expect(intent.variantProfileVersion).toBe("v1");
    // deadlines: 22h / 24h / 25h
    const created = intent.createdAt.getTime();
    expect(intent.tokenIssueDeadlineAt.getTime() - created).toBe(22 * 3600_000);
    expect(intent.intentFinalizeDeadlineAt.getTime() - created).toBe(24 * 3600_000);
    expect(intent.storageCleanupNotBefore.getTime() - created).toBe(25 * 3600_000);

    const session = await prisma.uploadSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.nextUploadSortOrder).toBe(1);

    // response / token は UploadItem を作らない
    expect(await prisma.uploadItem.count({ where: { workspaceId } })).toBe(0);
    // clientFileHash は response へ出さない
    expect(JSON.stringify(json)).not.toContain("a".repeat(64));
  });

  it("2) 同一clientUploadIdの再送はintentを増やさず200でtokenを再発行する", async () => {
    const { sessionId } = await makeSession("c2");
    const body = payload(sessionId);

    const first = await post(body);
    expect(first.status).toBe(201);
    const firstJson = await first.json();

    const second = await post(body);
    expect(second.status).toBe(200);
    const secondJson = await second.json();

    expect(secondJson.data.intentId).toBe(firstJson.data.intentId);
    expect(secondJson.data.reservedUploadItemId).toBe(firstJson.data.reservedUploadItemId);
    expect(secondJson.data.reservedSortOrder).toBe(firstJson.data.reservedSortOrder);
    expect(secondJson.data.upload.path).toBe(firstJson.data.upload.path);
    expect(secondJson.data.upload.token).toBeTruthy();

    expect(await prisma.uploadIntent.count({ where: { sessionId } })).toBe(1);
    const session = await prisma.uploadSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.nextUploadSortOrder).toBe(1); // 予約は1回だけ
  });

  it("3) 別clientUploadIdはそれぞれ別intent・連続sortOrderになる", async () => {
    const { sessionId } = await makeSession("c3");
    const a = await (await post(payload(sessionId))).json();
    const b = await (await post(payload(sessionId))).json();
    expect(a.data.intentId).not.toBe(b.data.intentId);
    expect([a.data.reservedSortOrder, b.data.reservedSortOrder].sort()).toEqual([0, 1]);
    expect(await prisma.uploadIntent.count({ where: { sessionId } })).toBe(2);
  });

  // ---- idempotency conflict --------------------------------------------

  it("4) 同一clientUploadIdでpayloadが違えば409 IDEMPOTENCY_CONFLICT・intent情報を返さない", async () => {
    const { sessionId } = await makeSession("c4");
    const body = payload(sessionId);
    const first = await (await post(body)).json();

    const res = await post({ ...body, declaredSizeBytes: 2048 });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe("IDEMPOTENCY_CONFLICT");
    // 既存 intent の情報を漏らさない
    const text = JSON.stringify(json);
    expect(text).not.toContain(first.data.intentId);
    expect(text).not.toContain(first.data.upload.path);
    expect(text).not.toContain("token");

    expect(await prisma.uploadIntent.count({ where: { sessionId } })).toBe(1);
  });

  // ---- auth / validation ------------------------------------------------

  it("5) 未認証は401", async () => {
    const { sessionId } = await makeSession("c5");
    currentUserId = `${RUN_NS}unset`; // auth mock が null を返す
    const res = await post(payload(sessionId));
    expect(res.status).toBe(401);
  });

  it("6) 他ユーザーのsessionは403", async () => {
    const { sessionId } = await makeSession("c6");
    currentUserId = `${RUN_NS}wc6other`;
    const res = await post(payload(sessionId));
    expect(res.status).toBe(403);
  });

  it("7) 存在しないsessionは404", async () => {
    const { workspaceId } = await makeSession("c7");
    const res = await post(payload(`${workspaceId}nosuch`));
    expect(res.status).toBe(404);
  });

  it("8) 非JSON Content-Type / 不正JSON / 追加キーは400", async () => {
    const { sessionId } = await makeSession("c8");
    expect((await post(payload(sessionId), "text/plain")).status).toBe(400);
    expect((await post("{not json", "application/json")).status).toBe(400);
    const extra = await post({ ...payload(sessionId), workspaceId: "injected" });
    expect(extra.status).toBe(400);
    expect(await prisma.uploadIntent.count({ where: { sessionId } })).toBe(0);
  });

  it("9) MIME不正は415、サイズ超過は413。いずれもintentを作らない", async () => {
    const { sessionId } = await makeSession("c9");
    expect((await post(payload(sessionId, { declaredMimeType: "image/gif" }))).status).toBe(415);
    expect((await post(payload(sessionId, { declaredSizeBytes: 6 * 1024 * 1024 }))).status).toBe(413);
    expect(await prisma.uploadIntent.count({ where: { sessionId } })).toBe(0);
    expect(createSignedUploadUrlCalls).toHaveLength(0);
  });

  // ---- session state ----------------------------------------------------

  it("10) ACTIVEでないsessionは400・intentを作らない", async () => {
    const { sessionId } = await makeSession("c10", { status: "PREVIEWING" });
    const res = await post(payload(sessionId));
    expect(res.status).toBe(400);
    expect(await prisma.uploadIntent.count({ where: { sessionId } })).toBe(0);
  });

  it("11) session cleanup lease有効中は409 SESSION_CLEANUP_IN_PROGRESS・token発行なし", async () => {
    const { sessionId } = await makeSession("c11", { cleanupLeaseUntil: new Date(Date.now() + 60_000) });
    const res = await post(payload(sessionId));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("SESSION_CLEANUP_IN_PROGRESS");
    expect(await prisma.uploadIntent.count({ where: { sessionId } })).toBe(0);
    expect(createSignedUploadUrlCalls).toHaveLength(0);
  });

  it("12) 失効したsession cleanup leaseはブロックしない", async () => {
    const { sessionId } = await makeSession("c12", { cleanupLeaseUntil: new Date(Date.now() - 1000) });
    expect((await post(payload(sessionId))).status).toBe(201);
  });

  // ---- existing intent states -------------------------------------------

  it("13) intent cleanup lease有効中は409 INTENT_CLEANUP_IN_PROGRESS", async () => {
    const { sessionId } = await makeSession("c13");
    const body = payload(sessionId);
    const first = await (await post(body)).json();
    await prisma.uploadIntent.update({
      where: { id: first.data.intentId },
      data: { cleanupLeaseUntil: new Date(Date.now() + 60_000) },
    });

    const res = await post(body);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("INTENT_CLEANUP_IN_PROGRESS");
  });

  it("14) token発行期限超過(finalize期限内)は409 TOKEN_ISSUE_DEADLINE_EXCEEDED・token発行なし", async () => {
    const { sessionId } = await makeSession("c14");
    const body = payload(sessionId);
    const first = await (await post(body)).json();
    createSignedUploadUrlCalls.length = 0;
    await prisma.uploadIntent.update({
      where: { id: first.data.intentId },
      data: {
        tokenIssueDeadlineAt: new Date(Date.now() - 1000),
        intentFinalizeDeadlineAt: new Date(Date.now() + 3600_000),
      },
    });

    const res = await post(body);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("TOKEN_ISSUE_DEADLINE_EXCEEDED");
    expect(createSignedUploadUrlCalls).toHaveLength(0);
  });

  it("15) finalize期限超過はEXPIREDへ遷移し400 INTENT_EXPIRED", async () => {
    const { sessionId } = await makeSession("c15");
    const body = payload(sessionId);
    const first = await (await post(body)).json();
    createSignedUploadUrlCalls.length = 0;
    await prisma.uploadIntent.update({
      where: { id: first.data.intentId },
      data: {
        tokenIssueDeadlineAt: new Date(Date.now() - 7200_000),
        intentFinalizeDeadlineAt: new Date(Date.now() - 1000),
      },
    });

    const res = await post(body);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INTENT_EXPIRED");
    const intent = await prisma.uploadIntent.findUniqueOrThrow({ where: { id: first.data.intentId } });
    expect(intent.status).toBe("EXPIRED");
    expect(createSignedUploadUrlCalls).toHaveLength(0);
  });

  it("16) FINALIZINGは409 FINALIZE_IN_PROGRESS", async () => {
    const { sessionId } = await makeSession("c16");
    const body = payload(sessionId);
    const first = await (await post(body)).json();
    await prisma.uploadIntent.update({ where: { id: first.data.intentId }, data: { status: "FINALIZING" } });

    const res = await post(body);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("FINALIZE_IN_PROGRESS");
  });

  it("17) FINALIZEDはtokenなしの冪等結果を200で返す", async () => {
    const { sessionId } = await makeSession("c17");
    const body = payload(sessionId);
    const first = await (await post(body)).json();
    await prisma.uploadIntent.update({
      where: { id: first.data.intentId },
      data: { status: "FINALIZED", uploadItemId: `${RUN_NS}wc17item`, finalizedAt: new Date() },
    });
    createSignedUploadUrlCalls.length = 0;

    const res = await post(body);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.alreadyFinalized).toBe(true);
    expect(json.data.uploadItemId).toBe(`${RUN_NS}wc17item`);
    expect(json.data.upload).toBeUndefined();
    expect(createSignedUploadUrlCalls).toHaveLength(0);
  });

  it("18) FAILED / EXPIRED / CANCELLED は400 INTENT_NOT_REUSABLE", async () => {
    for (const status of ["FAILED", "EXPIRED", "CANCELLED"] as const) {
      const { sessionId } = await makeSession(`c18${status.toLowerCase()}`);
      const body = payload(sessionId);
      const first = await (await post(body)).json();
      await prisma.uploadIntent.update({ where: { id: first.data.intentId }, data: { status } });
      createSignedUploadUrlCalls.length = 0;

      const res = await post(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("INTENT_NOT_REUSABLE");
      expect(createSignedUploadUrlCalls).toHaveLength(0);

      await cleanupNamespace(sessionId.replace(/s$/, ""));
      currentCaseWorkspaceId = null;
    }
  });

  // ---- token issuance failure -------------------------------------------

  it("19) token発行失敗は500・intentはPREPAREDのまま・同じkeyで再試行可能", async () => {
    const { sessionId } = await makeSession("c19");
    const body = payload(sessionId);
    signedUrlBehaviour = "error";

    const res = await post(body);
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("SIGNED_UPLOAD_URL_ISSUE_FAILED");

    const intent = await prisma.uploadIntent.findFirstOrThrow({ where: { sessionId } });
    expect(intent.status).toBe("PREPARED");
    expect(intent.signedUploadIssuedAt).toBeNull();
    expect(intent.lastErrorCode).toBe("SIGNED_UPLOAD_URL_ISSUE_FAILED");
    // provider message / path / hash を保存しない
    expect(intent.lastErrorDetail).toBe("Signed upload token issuance failed");
    expect(intent.lastErrorDetail).not.toContain("provider exploded");

    // 同じ clientUploadId で再試行 → 成功し、lastError がクリアされる
    signedUrlBehaviour = "ok";
    const retry = await post(body);
    expect(retry.status).toBe(200);
    const after = await prisma.uploadIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(after.signedUploadIssuedAt).not.toBeNull();
    expect(after.lastErrorCode).toBeNull();
    expect(await prisma.uploadIntent.count({ where: { sessionId } })).toBe(1); // 増殖しない
  });

  it("20) 空token / path不一致も500として扱いtokenを返さない", async () => {
    for (const behaviour of ["empty_token", "path_mismatch"] as const) {
      const { sessionId } = await makeSession(`c20${behaviour}`);
      signedUrlBehaviour = behaviour;
      const res = await post(payload(sessionId));
      expect(res.status).toBe(500);
      expect((await res.json()).error.code).toBe("SIGNED_UPLOAD_URL_ISSUE_FAILED");
      await cleanupNamespace(sessionId.replace(/s$/, ""));
      currentCaseWorkspaceId = null;
      signedUrlBehaviour = "ok";
    }
  });

  // ---- concurrency ------------------------------------------------------

  it("21) 同一 session+clientUploadId の並行prepareでもintentは1件・予約は1回だけ", async () => {
    const { sessionId } = await makeSession("c21");
    const body = payload(sessionId);

    const results = await Promise.all([post(body), post(body), post(body), post(body), post(body)]);
    const statuses = results.map((r) => r.status).sort();
    for (const s of statuses) expect([200, 201]).toContain(s);

    expect(await prisma.uploadIntent.count({ where: { sessionId } })).toBe(1);
    const session = await prisma.uploadSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.nextUploadSortOrder).toBe(1); // counter増加は1
  });

  it("22) 別clientUploadIdの並行prepareはsortOrderが重複しない", async () => {
    const { sessionId } = await makeSession("c22");
    const bodies = Array.from({ length: 5 }, () => payload(sessionId));
    const results = await Promise.all(bodies.map((b) => post(b)));
    for (const r of results) expect(r.status).toBe(201);
    const jsons = await Promise.all(results.map((r) => r.json()));
    const orders = jsons.map((j) => j.data.reservedSortOrder).sort((a: number, b: number) => a - b);
    expect(orders).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(jsons.map((j) => j.data.intentId)).size).toBe(5);
  });

  // ---- direct upload gate ------------------------------------------------
  // このfile冒頭の vi.mock は gate=有効固定。gate が閉じている場合の挙動だけは
  // ここで vi.doMock + resetModules により個別に上書きし、他の全testへ影響
  // しないよう最後に必ず元へ戻す（このtestはfile内最後のtestでもある）。

  it("23) direct upload gateが閉じている場合は404 NOT_FOUND（authより前段でブロックされる）", async () => {
    currentUserId = `${RUN_NS}unset`; // 未認証のまま。gateはauthより前段で判定するはず
    expect(await countNamespace(RUN_NS)).toBe(0); // このtestはsessionを作らない

    vi.resetModules();
    vi.doMock("@/lib/upload/directUploadFeature", () => ({
      readDirectUploadEnabledFlag: () => false,
    }));

    try {
      const { POST: gatedPOST } = await import("./route");
      const req = new Request("http://localhost/api/uploads/items/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload(`${RUN_NS}wc23nonexistent`)),
      });
      const res = await gatedPOST(req as unknown as Parameters<typeof POST>[0]);

      expect(res.status).toBe(404);
      expect(res.status).not.toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe("NOT_FOUND");

      // authorizeSession / DB書き込みが一切呼ばれていない
      expect(await countNamespace(RUN_NS)).toBe(0);
      expect(createSignedUploadUrlCalls).toHaveLength(0);
    } finally {
      vi.doUnmock("@/lib/upload/directUploadFeature");
      vi.resetModules();
    }
  });
});
