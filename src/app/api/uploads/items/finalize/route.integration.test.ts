// Phase 10-43-B3b-2: integration test for POST /api/uploads/items/finalize.
// Drives the real route handler against an isolated local Postgres. auth /
// Supabase Storage / signed URL 発行 / rate limiter backend は mock し、
// 実 Supabase・実 Redis へは一切接続しない。画像バイトは repository へ
// fixture を追加せず test 実行時に sharp で生成する。
//
// Opt-in via PHOTOBOX_TEST_DATABASE_URL (isolated, localhost/127.0.0.1 only);
// 未設定時は DB 依存 describe を skip する（pure/mock cases は DB なしで pass）。
//
// Fixture isolation は B1.1 discipline: このファイルが作る全 row は per-process,
// per-file-load の RUN_NS prefix 配下に namespace 化し、cleanup も必ず prefix
// scope（unscoped deleteMany は使わない）。

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { hashIdentity } from "@/lib/rateLimitCore";
import { FINALIZE_LEASE_MS } from "@/lib/upload/uploadIntentCore";
import { MAX_ORIGINAL_BYTES } from "@/lib/upload/uploadLimits";
import { MAX_IMAGE_PIXELS } from "@/lib/upload/finalizeMeasurement";

const TEST_DATABASE_URL = process.env.PHOTOBOX_TEST_DATABASE_URL;

const RUN_NS = `b3b2_finalize_${process.pid}_${crypto.randomUUID().replace(/-/g, "")}_`;

function assertLocalOnly(url: string) {
  const parsed = new URL(url);
  if (!["localhost", "127.0.0.1"].includes(parsed.hostname)) {
    throw new Error(
      `PHOTOBOX_TEST_DATABASE_URL must point at localhost/127.0.0.1 only, got hostname "${parsed.hostname}"`,
    );
  }
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// auth mock
// ---------------------------------------------------------------------------

let currentUserId = `${RUN_NS}unset`;

vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () =>
    currentUserId.endsWith("unset") ? null : { id: currentUserId, email: "t@example.com" },
}));

// ---------------------------------------------------------------------------
// rate limiter backend mock — @/lib/rateLimit と @/lib/rateLimitCore は実 code を
// 通す（preset 名 / config / prefix / userId-only key を実挙動で検証するため）。
// Redis backend（@upstash/ratelimit + redisClient）だけを差し替える。
// ---------------------------------------------------------------------------

let rateLimitDeny = false;
const rateLimiterLimitCalls: string[] = [];
const ratelimitCtorConfigs: Array<{ prefix: unknown; limiter: unknown }> = [];
const slidingWindowArgs: Array<[number, string]> = [];

vi.mock("@upstash/ratelimit", () => {
  class Ratelimit {
    static slidingWindow(limit: number, window: string) {
      slidingWindowArgs.push([limit, window]);
      return { __slidingWindow: [limit, window] };
    }
    constructor(cfg: { prefix: string; limiter: unknown }) {
      ratelimitCtorConfigs.push({ prefix: cfg.prefix, limiter: cfg.limiter });
    }
    async limit(key: string) {
      rateLimiterLimitCalls.push(key);
      if (rateLimitDeny) {
        return { success: false, limit: 60, remaining: 0, reset: Date.now() + 60_000 };
      }
      return { success: true, limit: 60, remaining: 59, reset: Date.now() + 60_000 };
    }
  }
  return { Ratelimit };
});

vi.mock("@/lib/cache/redisClient", () => ({ getRedisClient: () => ({}) }));

// ---------------------------------------------------------------------------
// Supabase Storage mock — in-memory object store（形状は installed storage-js
// 2.108.2 に忠実: StorageApiError 形 {status:number, statusCode:string}、
// download の非 StorageError は throw、upload の重複は 409 Duplicate）。
// ---------------------------------------------------------------------------

type StoredObject = { bytes: Buffer; contentType: string | undefined };
const objectStore = new Map<string, StoredObject>();
const downloadCalls: string[] = [];
const uploadCalls: Array<{ path: string; upsert: unknown; contentType: unknown; size: number }> = [];
const signedUrlCalls: Array<{ path: string; expiresIn: number }> = [];

function storageApiError(status: number, statusCode: string, message: string) {
  return { name: "StorageApiError", message, status, statusCode, __isStorageError: true };
}

type StorageOutcome = { data: unknown; error: unknown } | "throw_plain";
let downloadOverride: ((path: string) => StorageOutcome | null) | null = null;
let uploadOverride: ((path: string) => { error: unknown } | null) | null = null;
let signedUrlBehaviour: "ok" | "error" = "ok";
let downloadHold: Promise<void> | null = null;
// null = hold は全 path 対象（既存 test の挙動を維持）。値ありなら該当 path のみ hold し、
// 他 path の download は即座に進める（Test B: staging download は素通し・canonical
// 再検証 download だけを barrier で止める、というシナリオを表現するために追加）。
let downloadHoldPath: string | null = null;
let uploadHold: Promise<void> | null = null;

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    storage: {
      from: () => ({
        download: async (path: string) => {
          downloadCalls.push(path);
          if (downloadHold && (downloadHoldPath === null || downloadHoldPath === path)) await downloadHold;
          if (downloadOverride) {
            const r = downloadOverride(path);
            if (r === "throw_plain") throw new Error("socket hang up: internal provider detail");
            if (r) return r;
          }
          const obj = objectStore.get(path);
          if (!obj) return { data: null, error: storageApiError(404, "404", "Object not found") };
          return { data: new Blob([new Uint8Array(obj.bytes)]), error: null };
        },
        upload: async (path: string, body: Buffer, opts?: { contentType?: string; upsert?: boolean }) => {
          uploadCalls.push({ path, upsert: opts?.upsert, contentType: opts?.contentType, size: body.length });
          if (uploadHold) await uploadHold;
          if (uploadOverride) {
            const r = uploadOverride(path);
            if (r) return { data: null, error: r.error };
          }
          if (objectStore.has(path) && !opts?.upsert) {
            return { data: null, error: storageApiError(409, "Duplicate", "The resource already exists") };
          }
          objectStore.set(path, { bytes: Buffer.from(body), contentType: opts?.contentType });
          return { data: { path }, error: null };
        },
        createSignedUrl: async (path: string, expiresIn: number) => {
          signedUrlCalls.push({ path, expiresIn });
          if (signedUrlBehaviour === "error") {
            return { data: null, error: storageApiError(500, "500", "signer exploded") };
          }
          return { data: { signedUrl: `https://signed.example.test/${path}?token=sig` }, error: null };
        },
      }),
    },
  },
}));

// このfile全体は direct upload gate が開いている前提。gate 閉塞は個別 test が
// vi.doMock + resetModules で検証する。
vi.mock("@/lib/upload/directUploadFeature", () => ({
  readDirectUploadEnabledFlag: () => true,
}));

// prisma: isolated Postgres への実接続（singleton — resetModules 後の再 import
// でも接続を増やさない）。
let prismaSingleton: PrismaClient | null = null;
vi.mock("@/lib/prisma", async () => {
  if (!TEST_DATABASE_URL) return { prisma: null };
  if (!prismaSingleton) {
    const { PrismaClient: PC } = await import("@/generated/prisma/client");
    const adapter = new PrismaPg({ connectionString: TEST_DATABASE_URL });
    prismaSingleton = new PC({ adapter });
  }
  return { prisma: prismaSingleton };
});

// sharp: 実装は実 sharp のまま、constructor options だけを記録する wrapper。
// full decode の limitInputPixels 契約（B3a carry-forward）を route 経由で固定する。
const sharpCtorOptions: Array<Record<string, unknown>> = [];
vi.mock("sharp", async (importOriginal) => {
  const actual = (await importOriginal()) as { default: typeof import("sharp") };
  const real = actual.default;
  const wrapped = ((...args: unknown[]) => {
    const opts = args[1];
    if (opts && typeof opts === "object" && "limitInputPixels" in opts) {
      sharpCtorOptions.push({ ...(opts as Record<string, unknown>) });
    }
    return (real as unknown as (...a: unknown[]) => unknown)(...args);
  }) as unknown as typeof real;
  Object.assign(wrapped, real);
  return { default: wrapped };
});

// ---------------------------------------------------------------------------
// 共通 helpers
// ---------------------------------------------------------------------------

type RoutePOST = (typeof import("./route"))["POST"];
let POST: RoutePOST;

async function post(body: unknown, contentType: string | null = "application/json") {
  const req = new Request("http://localhost/api/uploads/items/finalize", {
    method: "POST",
    headers: contentType ? { "content-type": contentType } : {},
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return POST(req as unknown as Parameters<RoutePOST>[0]);
}

function makeHold() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function resetKnobs() {
  objectStore.clear();
  downloadCalls.length = 0;
  uploadCalls.length = 0;
  signedUrlCalls.length = 0;
  rateLimiterLimitCalls.length = 0;
  sharpCtorOptions.length = 0;
  downloadOverride = null;
  uploadOverride = null;
  signedUrlBehaviour = "ok";
  rateLimitDeny = false;
  downloadHold = null;
  downloadHoldPath = null;
  uploadHold = null;
  currentUserId = `${RUN_NS}unset`;
}

beforeAll(async () => {
  ({ POST } = await import("./route"));
});

afterEach(() => {
  resetKnobs();
});

// 画像 fixtures（beforeAll で 1 回生成。binary fixture は repo へ置かない）
let jpeg40x20: Buffer;
let png10x10: Buffer;
let webp16x8: Buffer;
let corruptJpeg: Buffer;
let animatedWebp: Buffer;

beforeAll(async () => {
  const sharp = (await import("sharp")).default;
  jpeg40x20 = await sharp({ create: { width: 40, height: 20, channels: 3, background: { r: 10, g: 200, b: 30 } } })
    .jpeg()
    .toBuffer();
  png10x10 = await sharp({ create: { width: 10, height: 10, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 0.5 } } })
    .png()
    .toBuffer();
  webp16x8 = await sharp({ create: { width: 16, height: 8, channels: 3, background: { r: 250, g: 250, b: 0 } } })
    .webp()
    .toBuffer();
  // header は valid・本体を切り詰めた壊れ JPEG（metadata は通り stats で落ちる）
  corruptJpeg = jpeg40x20.subarray(0, Math.floor(jpeg40x20.length / 2));
  const frameA = await sharp({ create: { width: 12, height: 12, channels: 3, background: { r: 255, g: 0, b: 0 } } })
    .webp()
    .toBuffer();
  const frameB = await sharp({ create: { width: 12, height: 12, channels: 3, background: { r: 0, g: 0, b: 255 } } })
    .webp()
    .toBuffer();
  animatedWebp = await sharp([frameA, frameB], { join: { animated: true } })
    .webp()
    .toBuffer();
});

// ---------------------------------------------------------------------------
// DB 不要（pure / mock）ケース — PHOTOBOX_TEST_DATABASE_URL なしでも pass する
// ---------------------------------------------------------------------------

describe("POST /api/uploads/items/finalize (DB-less: gate / auth / rate limit / payload)", () => {
  it("1) feature gate 無効時は auth より前に 404（rate limit / Storage / sharp 未到達）", async () => {
    currentUserId = `${RUN_NS}unset`; // 未認証のまま — gate が auth より前なら 401 ではなく 404
    vi.resetModules();
    vi.doMock("@/lib/upload/directUploadFeature", () => ({
      readDirectUploadEnabledFlag: () => false,
    }));
    try {
      const { POST: gatedPOST } = await import("./route");
      const req = new Request("http://localhost/api/uploads/items/finalize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intentId: "cmxxgate" }),
      });
      const res = await gatedPOST(req as unknown as Parameters<RoutePOST>[0]);
      expect(res.status).toBe(404);
      expect(res.status).not.toBe(401);
      expect((await res.json()).error.code).toBe("NOT_FOUND");
      expect(rateLimiterLimitCalls).toHaveLength(0);
      expect(downloadCalls).toHaveLength(0);
      expect(uploadCalls).toHaveLength(0);
      expect(sharpCtorOptions).toHaveLength(0);
    } finally {
      // doUnmock だと file-level mock ごと恒久解除され、後続の resetModules +
      // 再 import 系 test が実 flag（無効=404）を見てしまう。gate 有効の mock を
      // 明示的に再登録して復元する。
      vi.doMock("@/lib/upload/directUploadFeature", () => ({
        readDirectUploadEnabledFlag: () => true,
      }));
      vi.resetModules();
    }
  });

  it("2) 未認証は 401・rate limit 未到達（auth が rate limit より前）", async () => {
    currentUserId = `${RUN_NS}unset`;
    rateLimitDeny = true; // rate limit が auth より前なら 429 になるはず
    const res = await post({ intentId: "cmxxauth" });
    expect(res.status).toBe(401);
    expect(rateLimiterLimitCalls).toHaveLength(0);
  });

  it("3) rate limit denied は 429・JSON parse / Storage 未到達・userId 単位 key", async () => {
    currentUserId = `${RUN_NS}dbless`;
    rateLimitDeny = true;
    // body を invalid JSON にする — rate limit が parse より前なら 400 ではなく 429
    const res = await post("{not json");
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("RATE_LIMITED");
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(downloadCalls).toHaveLength(0);
    expect(uploadCalls).toHaveLength(0);
    // userId 単位（workspaceId なし）の hash key
    expect(rateLimiterLimitCalls).toEqual([hashIdentity(`user:${RUN_NS}dbless`)]);
  });

  it("4) preset は uploadFinalize（prefix ratelimit:uploadFinalize / 60 req / 1 m）", async () => {
    currentUserId = `${RUN_NS}dbless`;
    await post("{not json"); // 400 で良い — limiter 初期化だけが目的
    expect(slidingWindowArgs).toContainEqual([60, "1 m"]);
    expect(ratelimitCtorConfigs.some((c) => c.prefix === "ratelimit:uploadFinalize")).toBe(true);
  });

  it("5) Content-Type 不正 / invalid JSON / 追加キー / 型不正はいずれも 400", async () => {
    currentUserId = `${RUN_NS}dbless`;
    expect((await post({ intentId: "cmxx" }, "text/plain")).status).toBe(400);
    expect((await post("{not json")).status).toBe(400);
    expect((await post({ intentId: "cmxx", workspaceId: "injected" })).status).toBe(400);
    expect((await post({ intentId: 42 })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post({ intentId: "../etc" })).status).toBe(400);
    expect(downloadCalls).toHaveLength(0);
  });

  it("6) route source は Production measurement entry のみ使用（test-only entry importer なし）", () => {
    const source = readFileSync(fileURLToPath(new URL("./route.ts", import.meta.url)), "utf8");
    expect(source).toContain("measureStagedImage");
    expect(source).not.toContain("measureStagedImageWithMaxPixelsForTest");
  });
});

// ---------------------------------------------------------------------------
// isolated Postgres integration
// ---------------------------------------------------------------------------

describe.skipIf(!TEST_DATABASE_URL)("POST /api/uploads/items/finalize (isolated Postgres integration)", () => {
  let prisma: PrismaClient;
  let currentCaseWorkspaceId: string | null = null;
  let seq = 0;

  async function cleanupNamespace(prefix: string) {
    await prisma.uploadIntent.deleteMany({ where: { workspaceId: { startsWith: prefix } } });
    await prisma.uploadItem.deleteMany({ where: { workspaceId: { startsWith: prefix } } });
    await prisma.image.deleteMany({ where: { workspaceId: { startsWith: prefix } } });
    await prisma.uploadSession.deleteMany({ where: { workspaceId: { startsWith: prefix } } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: { startsWith: prefix } } });
    await prisma.workspace.deleteMany({ where: { id: { startsWith: prefix } } });
  }

  async function countNamespace(prefix: string) {
    const [intents, items, images, sessions, members, workspaces] = await Promise.all([
      prisma.uploadIntent.count({ where: { workspaceId: { startsWith: prefix } } }),
      prisma.uploadItem.count({ where: { workspaceId: { startsWith: prefix } } }),
      prisma.image.count({ where: { workspaceId: { startsWith: prefix } } }),
      prisma.uploadSession.count({ where: { workspaceId: { startsWith: prefix } } }),
      prisma.workspaceMember.count({ where: { workspaceId: { startsWith: prefix } } }),
      prisma.workspace.count({ where: { id: { startsWith: prefix } } }),
    ]);
    return intents + items + images + sessions + members + workspaces;
  }

  beforeAll(async () => {
    assertLocalOnly(TEST_DATABASE_URL!);
    ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
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
  });

  type CaseCtx = { workspaceId: string; sessionId: string; userId: string };

  async function makeCase(
    label: string,
    over: {
      sessionStatus?: "ACTIVE" | "PREVIEWING" | "ABANDONED" | "COMMITTED";
      sessionCleanupLeaseUntil?: Date | null;
      counter?: number;
    } = {},
  ): Promise<CaseCtx> {
    const workspaceId = `${RUN_NS}w${label}`;
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
        status: over.sessionStatus ?? "ACTIVE",
        cleanupLeaseUntil: over.sessionCleanupLeaseUntil ?? null,
        // reservedSortOrder(3) と一致しない値にして、再採番/increment の混入を検出する
        nextUploadSortOrder: over.counter ?? 5,
      },
    });
    return { workspaceId, sessionId, userId };
  }

  type IntentRefs = {
    intentId: string;
    reservedUploadItemId: string;
    stagingPath: string;
    canonicalPath: (ext: string) => string;
    thumbnailPath: string;
    previewPath: string;
  };

  async function makeIntent(
    ctx: CaseCtx,
    img: Buffer,
    mime: string,
    over: Partial<Prisma.UploadIntentUncheckedCreateInput> = {},
    opts: { seedStaging?: boolean } = {},
  ): Promise<IntentRefs> {
    const intentId = `${ctx.workspaceId}i${++seq}`;
    const reservedUploadItemId = `${intentId}item`;
    const stagingPath = `${ctx.workspaceId}/upload-intents/${ctx.sessionId}/${intentId}/original`;
    const base = Date.now();
    await prisma.uploadIntent.create({
      data: {
        id: intentId,
        workspaceId: ctx.workspaceId,
        sessionId: ctx.sessionId,
        userId: ctx.userId,
        reservedUploadItemId,
        clientUploadId: crypto.randomUUID(),
        requestFingerprint: "f".repeat(64),
        declaredOriginalName: "photo.jpg",
        declaredMimeType: mime,
        declaredSizeBytes: img.length,
        clientFileHash: sha256(img),
        stagingOriginalPath: stagingPath,
        reservedSortOrder: 3,
        variantProfileVersion: "v1",
        tokenIssueDeadlineAt: new Date(base + 22 * 3600_000),
        intentFinalizeDeadlineAt: new Date(base + 24 * 3600_000),
        storageCleanupNotBefore: new Date(base + 25 * 3600_000),
        ...over,
      },
    });
    if (opts.seedStaging !== false) {
      objectStore.set(stagingPath, { bytes: img, contentType: undefined });
    }
    const dir = `${ctx.workspaceId}/uploads/${ctx.sessionId}/${reservedUploadItemId}`;
    return {
      intentId,
      reservedUploadItemId,
      stagingPath,
      canonicalPath: (ext: string) => `${dir}/original.${ext}`,
      thumbnailPath: `${dir}/thumbnail.webp`,
      previewPath: `${dir}/preview.webp`,
    };
  }

  async function makeItemRow(ctx: CaseCtx, refs: IntentRefs, over: Partial<Prisma.UploadItemUncheckedCreateInput> = {}) {
    await prisma.uploadItem.create({
      data: {
        id: refs.reservedUploadItemId,
        workspaceId: ctx.workspaceId,
        sessionId: ctx.sessionId,
        sortOrder: 3,
        originalName: "photo.jpg",
        originalExt: "jpg",
        mimeType: "image/jpeg",
        fileSizeBytes: 100,
        fileHash: "b".repeat(64),
        tempStoragePath: refs.canonicalPath("jpg"),
        uploadStatus: "READY",
        promptStatus: "EMPTY",
        duplicateStatus: "CLEAN",
        commitStatus: "PENDING",
        ...over,
      },
    });
  }

  const intentRow = (id: string) => prisma.uploadIntent.findUniqueOrThrow({ where: { id } });
  const itemCount = (workspaceId: string) => prisma.uploadItem.count({ where: { workspaceId } });

  // ---- 認可 ---------------------------------------------------------------

  it("10) 存在しない intent は 404", async () => {
    await makeCase("c10");
    const res = await post({ intentId: `${RUN_NS}nosuch` });
    expect(res.status).toBe(404);
    expect(downloadCalls).toHaveLength(0);
  });

  it("11) 他ユーザーの intent は 403", async () => {
    const ctx = await makeCase("c11");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg");
    currentUserId = `${ctx.workspaceId}other`;
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(403);
    expect(downloadCalls).toHaveLength(0);
  });

  it("12) session 削除後（cascade で intent ごと消える）は 404", async () => {
    const ctx = await makeCase("c12");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg");
    await prisma.uploadSession.delete({ where: { id: ctx.sessionId } });
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(404);
  });

  it("13) session の userId 不一致は 403", async () => {
    const ctx = await makeCase("c13");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg");
    await prisma.uploadSession.update({
      where: { id: ctx.sessionId },
      data: { userId: `${ctx.workspaceId}stranger` },
    });
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(403);
  });

  it("14) workspace membership なしは 403", async () => {
    const ctx = await makeCase("c14");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg");
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: ctx.workspaceId } });
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(403);
    expect(downloadCalls).toHaveLength(0);
  });

  it("15) FINALIZED replay でも ownership 必須（他ユーザーは 403）", async () => {
    const ctx = await makeCase("c15");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg", {
      status: "FINALIZED",
      uploadItemId: `${ctx.workspaceId}i0item_c15`,
      finalizedAt: new Date(),
    });
    await makeItemRow(ctx, refs, { id: `${ctx.workspaceId}i0item_c15` });
    currentUserId = `${ctx.workspaceId}other`;
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(403);
    expect(downloadCalls).toHaveLength(0);
    expect(signedUrlCalls).toHaveLength(0);
  });

  it("16) FINALIZED replay でも membership 必須（剥奪済みは 403）", async () => {
    const ctx = await makeCase("c16");
    const itemId = `${ctx.workspaceId}i0item_c16`;
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg", {
      status: "FINALIZED",
      uploadItemId: itemId,
      finalizedAt: new Date(),
    });
    await makeItemRow(ctx, refs, { id: itemId });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: ctx.workspaceId } });
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(403);
    expect(signedUrlCalls).toHaveLength(0);
  });

  it("16b) FINALIZED replayでもintent ownershipをsession ownershipとは独立して強制する", async () => {
    // 通常 prepare 経路では発生しない異常 DB 行（intent.userId だけが session.userId
    // と不一致）を直接構築し、route の defence-in-depth（intent 単独の ownership
    // check）が session/membership とは独立に効いていることを固定する。
    const ctx = await makeCase("ownA");
    const itemId = `${ctx.workspaceId}i0item_ownA`;
    const otherUserId = `${ctx.workspaceId}_intent_owner_mismatch`;
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg", {
      status: "FINALIZED",
      uploadItemId: itemId,
      finalizedAt: new Date(),
      userId: otherUserId, // intent.userId だけを意図的に不一致化
    });
    await makeItemRow(ctx, refs, { id: itemId });

    // fixture 前提の確認: session ownership は user-A（ctx.userId）のまま・
    // workspace membership も user-A に存在する。つまり intent ownership check を
    // 削除した場合、authorizeSession は普通に通過してしまう fixture である。
    const session = await prisma.uploadSession.findUniqueOrThrow({ where: { id: ctx.sessionId } });
    expect(session.userId).toBe(ctx.userId);
    expect(session.userId).not.toBe(otherUserId);
    const member = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: ctx.workspaceId, userId: ctx.userId } },
    });
    expect(member).not.toBeNull();

    const beforeIntent = await intentRow(refs.intentId);
    const beforeItem = await prisma.uploadItem.findUniqueOrThrow({ where: { id: itemId } });

    // currentUserId は makeCase 内で ctx.userId（= user-A）に設定済み。
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("FORBIDDEN");
    expect(JSON.stringify(body)).not.toContain(otherUserId);

    // Storage / sharp / signed URL いずれも未到達
    expect(downloadCalls).toHaveLength(0);
    expect(uploadCalls).toHaveLength(0);
    expect(sharpCtorOptions).toHaveLength(0);
    expect(signedUrlCalls).toHaveLength(0);

    // DB は一切変更されない（intent / item とも完全に不変）
    const afterIntent = await intentRow(refs.intentId);
    const afterItem = await prisma.uploadItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(afterIntent).toEqual(beforeIntent);
    expect(afterItem).toEqual(beforeItem);
    expect(await itemCount(ctx.workspaceId)).toBe(1); // 既存 item のみ・新規 create なし
  });

  // ---- happy path ----------------------------------------------------------

  it("20) PREPARED 正常系 JPEG: 201・厳密 field mapping・FINALIZED・Storage/log 契約", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const ctx = await makeCase("c20");
      const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg");
      const hash = sha256(jpeg40x20);
      sharpCtorOptions.length = 0;

      const res = await post({ intentId: refs.intentId });
      expect(res.status).toBe(201);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const json = await res.json();

      // ---- item mapping（reserved ID / sortOrder 厳守・F1〜F4） ----
      const item = json.data.item;
      expect(item.id).toBe(refs.reservedUploadItemId);
      expect(item.workspaceId).toBe(ctx.workspaceId);
      expect(item.sessionId).toBe(ctx.sessionId);
      expect(item.sortOrder).toBe(3); // reservedSortOrder（counter=5 からの再採番でない）
      expect(item.originalName).toBe("photo.jpg");
      expect(item.originalExt).toBe("jpg");
      expect(item.mimeType).toBe("image/jpeg");
      expect(item.fileSizeBytes).toBe(jpeg40x20.length);
      expect(item.widthPx).toBe(40);
      expect(item.heightPx).toBe(20);
      expect(item.fileHash).toBe(hash);
      expect(item.tempStoragePath).toBe(refs.canonicalPath("jpg"));
      expect(item.tempThumbnailPath).toBe(refs.thumbnailPath);
      expect(item.tempPreviewPath).toBe(refs.previewPath);
      expect(item.uploadStatus).toBe("READY"); // UPLOADING を経ない
      expect(item.promptStatus).toBe("EMPTY");
      expect(item.duplicateStatus).toBe("CLEAN");
      expect(item.duplicateImageId).toBeNull();
      expect(item.commitStatus).toBe("PENDING");
      // F1: commit 側の copy 先生成を壊さない（schema default null 維持）
      expect(item.reservedImageId).toBeNull();
      const dbItem = await prisma.uploadItem.findUniqueOrThrow({ where: { id: refs.reservedUploadItemId } });
      expect(dbItem.assetStoragePath).toBeNull();
      expect(dbItem.assetThumbnailPath).toBeNull();
      expect(dbItem.assetPreviewPath).toBeNull();
      expect(await itemCount(ctx.workspaceId)).toBe(1);

      // ---- intent FINALIZED ----
      const intent = await intentRow(refs.intentId);
      expect(intent.status).toBe("FINALIZED");
      expect(intent.uploadItemId).toBe(refs.reservedUploadItemId);
      expect(intent.finalizedAt).not.toBeNull();
      expect(intent.finalizeLeaseUntil).toBeNull();
      expect(intent.finalizeAttemptToken).toBeNull();
      expect(intent.finalizeAttemptCount).toBe(1);
      expect(intent.lastErrorCode).toBeNull();
      expect(intent.lastErrorDetail).toBeNull();
      expect(intent.canonicalOriginalPath).toBe(refs.canonicalPath("jpg"));

      // ---- session counter 非 increment ----
      const session = await prisma.uploadSession.findUniqueOrThrow({ where: { id: ctx.sessionId } });
      expect(session.nextUploadSortOrder).toBe(5);

      // ---- Storage 契約（canonical + variants・全て upsert:false） ----
      expect(downloadCalls).toEqual([refs.stagingPath]);
      const paths = uploadCalls.map((c) => c.path).sort();
      expect(paths).toEqual([refs.canonicalPath("jpg"), refs.previewPath, refs.thumbnailPath].sort());
      for (const call of uploadCalls) expect(call.upsert).toBe(false);
      const canonicalCall = uploadCalls.find((c) => c.path === refs.canonicalPath("jpg"))!;
      expect(canonicalCall.contentType).toBe("image/jpeg");
      expect(canonicalCall.size).toBe(jpeg40x20.length);
      for (const v of uploadCalls.filter((c) => c.path !== refs.canonicalPath("jpg"))) {
        expect(v.contentType).toBe("image/webp");
      }
      // staging object は削除されず残る（物理削除は B3c）
      expect(objectStore.has(refs.stagingPath)).toBe(true);

      // ---- sharp full-decode 契約（B3a carry-forward） ----
      // 1回目 = metadata（limitInputPixels:false）、2回目 = full decode（上限維持）
      expect(sharpCtorOptions[0]).toEqual({ limitInputPixels: false });
      expect(sharpCtorOptions[1]).toEqual({ limitInputPixels: MAX_IMAGE_PIXELS });

      // ---- response / signedUrls shape ----
      expect(Object.keys(json.data).sort()).toEqual(["item", "signedUrls"]);
      for (const variant of ["thumbnail", "preview", "original"] as const) {
        expect(json.data.signedUrls[variant].signedUrl).toContain("https://signed.example.test/");
        expect(json.data.signedUrls[variant].fallback).toBe(false);
      }
      // staging path / intent 内部状態は response へ出ない
      const text = JSON.stringify(json);
      expect(text).not.toContain("upload-intents");
      expect(text).not.toContain("finalizeAttemptToken");
      // hash は legacy 互換の item.fileHash として 1 回だけ現れる
      expect(text.split(hash).length - 1).toBe(1);

      // ---- perf log に token / staging path / hash を出さない ----
      const logged = JSON.stringify(infoSpy.mock.calls);
      expect(logged).not.toContain("upload-intents");
      expect(logged).not.toContain(hash);
      expect(logged).not.toContain("token=");
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("21) PNG は measured ext=png の canonical path", async () => {
    const ctx = await makeCase("c21");
    const refs = await makeIntent(ctx, png10x10, "image/png");
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.item.originalExt).toBe("png");
    expect(json.data.item.mimeType).toBe("image/png");
    expect(json.data.item.tempStoragePath).toBe(refs.canonicalPath("png"));
  });

  it("22) WebP は measured ext=webp の canonical path", async () => {
    const ctx = await makeCase("c22");
    const refs = await makeIntent(ctx, webp16x8, "image/webp");
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.item.originalExt).toBe("webp");
    expect(json.data.item.tempStoragePath).toBe(refs.canonicalPath("webp"));
  });

  // ---- read-side state 分類 -------------------------------------------------

  it("30) active FINALIZING（lease 有効）は 409 FINALIZE_IN_PROGRESS・download 未到達", async () => {
    const ctx = await makeCase("c30");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg", {
      status: "FINALIZING",
      finalizeLeaseUntil: new Date(Date.now() + 60_000),
      finalizeAttemptToken: crypto.randomUUID(),
      finalizeAttemptCount: 1,
    });
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("FINALIZE_IN_PROGRESS");
    expect(downloadCalls).toHaveLength(0);
    expect((await intentRow(refs.intentId)).finalizeAttemptCount).toBe(1);
  });

  it("31) stale FINALIZING（lease 失効・境界 lease<=now 含む）は回収して 201・attemptCount increment", async () => {
    const ctx = await makeCase("c31");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg", {
      status: "FINALIZING",
      finalizeStartedAt: new Date(Date.now() - 300_000),
      // 境界: leaseUntil <= now は「失効・回収可」
      finalizeLeaseUntil: new Date(Date.now() - 1),
      finalizeAttemptToken: crypto.randomUUID(),
      finalizeAttemptCount: 1,
    });
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(201);
    const intent = await intentRow(refs.intentId);
    expect(intent.status).toBe("FINALIZED");
    expect(intent.finalizeAttemptCount).toBe(2);
  });

  it("32) FINALIZED replay は 200・同一 data shape・download/upload/sharp/DB write ゼロ", async () => {
    const ctx = await makeCase("c32");
    const itemId = `${ctx.workspaceId}i0item_c32`;
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg", {
      status: "FINALIZED",
      uploadItemId: itemId,
      finalizedAt: new Date(),
      finalizeAttemptCount: 1,
    });
    await makeItemRow(ctx, refs, { id: itemId });
    const before = await intentRow(refs.intentId);
    sharpCtorOptions.length = 0;

    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const json = await res.json();
    expect(Object.keys(json.data).sort()).toEqual(["item", "signedUrls"]);
    expect(json.data.item.id).toBe(itemId);
    expect(Object.keys(json.data.signedUrls).sort()).toEqual(["original", "preview", "thumbnail"]);

    // Storage data-plane / sharp / DB write ゼロ
    expect(downloadCalls).toHaveLength(0);
    expect(uploadCalls).toHaveLength(0);
    expect(sharpCtorOptions).toHaveLength(0);
    const after = await intentRow(refs.intentId);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after.finalizeAttemptCount).toBe(1);
    expect(await itemCount(ctx.workspaceId)).toBe(1);
  });

  it("33) FINALIZED + UploadItem 削除済みは 404（500 にしない）", async () => {
    const ctx = await makeCase("c33");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg", {
      status: "FINALIZED",
      uploadItemId: `${ctx.workspaceId}gone`,
      finalizedAt: new Date(),
    });
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
    expect((await intentRow(refs.intentId)).status).toBe("FINALIZED"); // 不変
  });

  it("34) FAILED / EXPIRED / CANCELLED は 400 INTENT_NOT_REUSABLE", async () => {
    for (const status of ["FAILED", "EXPIRED", "CANCELLED"] as const) {
      const ctx = await makeCase(`c34${status.toLowerCase()}`);
      const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg", { status });
      const res = await post({ intentId: refs.intentId });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("INTENT_NOT_REUSABLE");
      expect(downloadCalls).toHaveLength(0);
      await cleanupNamespace(ctx.workspaceId);
      currentCaseWorkspaceId = null;
      resetKnobs();
    }
  });

  it("35) intent cleanup lease 有効中は 409 INTENT_CLEANUP_IN_PROGRESS", async () => {
    const ctx = await makeCase("c35");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg", {
      cleanupLeaseUntil: new Date(Date.now() + 60_000),
    });
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("INTENT_CLEANUP_IN_PROGRESS");
    expect(downloadCalls).toHaveLength(0);
  });

  it("36) session cleanup lease 有効中は 409 SESSION_CLEANUP_IN_PROGRESS", async () => {
    const ctx = await makeCase("c36", { sessionCleanupLeaseUntil: new Date(Date.now() + 60_000) });
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg");
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("SESSION_CLEANUP_IN_PROGRESS");
    expect(downloadCalls).toHaveLength(0);
  });

  it("37) 非 ACTIVE session（PREVIEWING / ABANDONED）は 400", async () => {
    for (const sessionStatus of ["PREVIEWING", "ABANDONED"] as const) {
      const ctx = await makeCase(`c37${sessionStatus.toLowerCase()}`, { sessionStatus });
      const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg");
      const res = await post({ intentId: refs.intentId });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
      await cleanupNamespace(ctx.workspaceId);
      currentCaseWorkspaceId = null;
      resetKnobs();
    }
  });

  it("38) finalize deadline 超過は EXPIRED へ遷移し 400 INTENT_EXPIRED・download 未到達", async () => {
    const ctx = await makeCase("c38");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg", {
      tokenIssueDeadlineAt: new Date(Date.now() - 7_200_000),
      intentFinalizeDeadlineAt: new Date(Date.now() - 1000),
    });
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INTENT_EXPIRED");
    expect((await intentRow(refs.intentId)).status).toBe("EXPIRED");
    expect(downloadCalls).toHaveLength(0);
  });

  it("39) deadline 未超過（近接未来）は通常どおり finalize できる", async () => {
    const ctx = await makeCase("c39");
    // 「now === deadline は未超過」の inclusive 側。正確な等値は単体（B3b-1）で
    // 固定済みのため、integration では通過側の近接値で退行を検出する。
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg", {
      intentFinalizeDeadlineAt: new Date(Date.now() + 30_000),
    });
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(201);
  });

  // ---- staging download（lease より前） -------------------------------------

  it("40) PREPARED + staging missing は 409 OBJECT_MISSING・PREPARED 維持・lease 未取得", async () => {
    const ctx = await makeCase("c40");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg", {}, { seedStaging: false });
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("OBJECT_MISSING");
    const intent = await intentRow(refs.intentId);
    // prepare 再送で token 再発行できる状態がそのまま残る
    expect(intent.status).toBe("PREPARED");
    expect(intent.finalizeLeaseUntil).toBeNull();
    expect(intent.finalizeAttemptToken).toBeNull();
    expect(intent.finalizeAttemptCount).toBe(0);
    expect(intent.tokenIssueDeadlineAt.getTime()).toBeGreaterThan(Date.now());
    expect(uploadCalls).toHaveLength(0);
    expect(await itemCount(ctx.workspaceId)).toBe(0);
  });

  it("41) stale FINALIZING + staging missing は guarded FAILED（STAGING_OBJECT_LOST）400", async () => {
    const ctx = await makeCase("c41");
    const refs = await makeIntent(
      ctx,
      jpeg40x20,
      "image/jpeg",
      {
        status: "FINALIZING",
        finalizeLeaseUntil: new Date(Date.now() - 1000),
        finalizeAttemptToken: crypto.randomUUID(),
        finalizeAttemptCount: 1,
      },
      { seedStaging: false },
    );
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INTENT_NOT_REUSABLE");
    const intent = await intentRow(refs.intentId);
    expect(intent.status).toBe("FAILED");
    expect(intent.lastErrorCode).toBe("STAGING_OBJECT_LOST");
    expect(intent.failedAt).not.toBeNull();
    expect(intent.finalizeLeaseUntil).toBeNull();
    expect(intent.finalizeAttemptToken).toBeNull();
  });

  it("42) missing 分類 race: 他 worker が FINALIZED 済みなら FAILED 化せず replay 200 へ収束", async () => {
    const ctx = await makeCase("c42");
    const itemId = `${ctx.workspaceId}i0item_c42`;
    const refs = await makeIntent(
      ctx,
      jpeg40x20,
      "image/jpeg",
      {
        status: "FINALIZING",
        finalizeLeaseUntil: new Date(Date.now() - 1000),
        finalizeAttemptToken: crypto.randomUUID(),
      },
      { seedStaging: false },
    );
    const hold = makeHold();
    downloadHold = hold.promise;
    const pending = post({ intentId: refs.intentId });
    await waitFor(() => downloadCalls.length >= 1);
    // download 中に他 worker が完了した状況を再現
    await makeItemRow(ctx, refs, { id: itemId });
    await prisma.uploadIntent.update({
      where: { id: refs.intentId },
      data: { status: "FINALIZED", uploadItemId: itemId, finalizedAt: new Date(), finalizeLeaseUntil: null, finalizeAttemptToken: null },
    });
    downloadHold = null;
    hold.resolve();
    const res = await pending;
    expect(res.status).toBe(200);
    expect((await res.json()).data.item.id).toBe(itemId);
    expect((await intentRow(refs.intentId)).status).toBe("FINALIZED"); // FAILED 化していない
  });

  it("43) staging download transient は 500 固定文・DB 無遷移・provider detail 非露出", async () => {
    const ctx = await makeCase("c43");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg");
    downloadOverride = (path) =>
      path === refs.stagingPath ? { data: null, error: storageApiError(500, "500", "backend fell over") } : null;
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(json)).not.toContain("backend fell over");
    const intent = await intentRow(refs.intentId);
    expect(intent.status).toBe("PREPARED");
    expect(intent.finalizeAttemptCount).toBe(0);
    expect(intent.finalizeAttemptToken).toBeNull();
    expect(intent.lastErrorCode).toBeNull(); // lease 未取得のため DB へ触れない
  });

  it("44) 非 StorageError throw（network 断など）も 500 固定文で contain される", async () => {
    const ctx = await makeCase("c44");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg");
    downloadOverride = (path) => (path === refs.stagingPath ? "throw_plain" : null);
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(json)).not.toContain("socket hang up");
    expect((await intentRow(refs.intentId)).status).toBe("PREPARED");
  });

  it("45) download は lease CAS より前（download 中は PREPARED のまま lease なし）", async () => {
    const ctx = await makeCase("c45");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg");
    const hold = makeHold();
    downloadHold = hold.promise;
    const pending = post({ intentId: refs.intentId });
    await waitFor(() => downloadCalls.length >= 1);
    const during = await intentRow(refs.intentId);
    expect(during.status).toBe("PREPARED");
    expect(during.finalizeAttemptToken).toBeNull();
    expect(during.finalizeAttemptCount).toBe(0);
    downloadHold = null;
    hold.resolve();
    expect((await pending).status).toBe(201);
  });

  // ---- lease CAS / attempt ownership ----------------------------------------

  it("50) 同一 PREPARED への 2 並行 finalize: 両者 download・lease 勝者 1・item 1・attemptCount 1", async () => {
    const ctx = await makeCase("c50");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg");
    const hold = makeHold();
    downloadHold = hold.promise;
    const p1 = post({ intentId: refs.intentId });
    const p2 = post({ intentId: refs.intentId });
    await waitFor(() => downloadCalls.length >= 2); // 重複 download は無害（read-only）
    downloadHold = null;
    hold.resolve();
    const [r1, r2] = await Promise.all([p1, p2]);
    const statuses = [r1.status, r2.status].sort();
    // 勝者 201。敗者は再分類の時点により 409（進行中）か 200（replay 収束）
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect([200, 409]).toContain(statuses.find((s) => s !== 201));
    const intent = await intentRow(refs.intentId);
    expect(intent.status).toBe("FINALIZED");
    expect(intent.finalizeAttemptCount).toBe(1); // 勝者だけが increment
    expect(await itemCount(ctx.workspaceId)).toBe(1);
    const items = await prisma.uploadItem.findMany({ where: { workspaceId: ctx.workspaceId } });
    expect(items[0].sortOrder).toBe(3);
  });

  it("51) lease 取得後の状態: FINALIZING・36 文字 UUID token・FINALIZE_LEASE_MS lease・path は PUT 前に保存済み", async () => {
    const ctx = await makeCase("c51");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg");
    const hold = makeHold();
    uploadHold = hold.promise;
    const pending = post({ intentId: refs.intentId });
    await waitFor(() => uploadCalls.length >= 1); // canonical PUT が in-flight
    const during = await intentRow(refs.intentId);
    expect(during.status).toBe("FINALIZING");
    expect(during.finalizeAttemptToken).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(during.finalizeAttemptToken).toHaveLength(36);
    expect(during.finalizeStartedAt).not.toBeNull();
    expect(during.finalizeLeaseUntil!.getTime() - during.finalizeStartedAt!.getTime()).toBe(FINALIZE_LEASE_MS);
    // canonical path は Storage PUT より前に DB 保存済み（DB 起点の追跡可能性）
    expect(during.canonicalOriginalPath).toBe(refs.canonicalPath("jpg"));
    // canonical object はまだ store に存在しない（PUT が hold 中）
    expect(objectStore.has(refs.canonicalPath("jpg"))).toBe(false);
    uploadHold = null;
    hold.resolve();
    expect((await pending).status).toBe(201);
  });

  it("52) CAS 直前に session cleanup lease が入った場合は 409・lease 未取得", async () => {
    const ctx = await makeCase("c52");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg");
    const hold = makeHold();
    downloadHold = hold.promise;
    const pending = post({ intentId: refs.intentId });
    await waitFor(() => downloadCalls.length >= 1);
    await prisma.uploadSession.update({
      where: { id: ctx.sessionId },
      data: { cleanupLeaseUntil: new Date(Date.now() + 60_000) },
    });
    downloadHold = null;
    hold.resolve();
    const res = await pending;
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("SESSION_CLEANUP_IN_PROGRESS");
    const intent = await intentRow(refs.intentId);
    expect(intent.status).toBe("PREPARED");
    expect(intent.finalizeAttemptToken).toBeNull();
    expect(await itemCount(ctx.workspaceId)).toBe(0);
  });

  it("53) CAS 直前に intent cleanup lease が入った場合は 409・lease 未取得", async () => {
    const ctx = await makeCase("c53");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg");
    const hold = makeHold();
    downloadHold = hold.promise;
    const pending = post({ intentId: refs.intentId });
    await waitFor(() => downloadCalls.length >= 1);
    await prisma.uploadIntent.update({
      where: { id: refs.intentId },
      data: { cleanupLeaseUntil: new Date(Date.now() + 60_000) },
    });
    downloadHold = null;
    hold.resolve();
    const res = await pending;
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("INTENT_CLEANUP_IN_PROGRESS");
    expect((await intentRow(refs.intentId)).status).toBe("PREPARED");
    expect(await itemCount(ctx.workspaceId)).toBe(0);
  });

  it("54a) CAS 直前の session ACTIVE→PREVIEWING race: lease を取得しない（PREPARED 維持・attemptCount 0）", async () => {
    const ctx = await makeCase("c54a");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg");
    const hold = makeHold();
    downloadHold = hold.promise;
    const pending = post({ intentId: refs.intentId });
    await waitFor(() => downloadCalls.length >= 1); // read 分類は通過済み・CAS はまだ
    await prisma.uploadSession.update({ where: { id: ctx.sessionId }, data: { status: "PREVIEWING" } });
    downloadHold = null;
    hold.resolve();
    const res = await pending;
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
    // CAS の session ACTIVE guard により lease は一切取得されない
    const intent = await intentRow(refs.intentId);
    expect(intent.status).toBe("PREPARED");
    expect(intent.finalizeAttemptCount).toBe(0);
    expect(intent.finalizeAttemptToken).toBeNull();
    expect(await itemCount(ctx.workspaceId)).toBe(0);
  });

  it("54) session ACTIVE→PREVIEWING race: UploadItem 0・FINALIZING 維持・400", async () => {
    const ctx = await makeCase("c54");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg");
    const hold = makeHold();
    uploadHold = hold.promise;
    const pending = post({ intentId: refs.intentId });
    await waitFor(() => uploadCalls.length >= 1); // lease 取得済み・canonical PUT 中
    await prisma.uploadSession.update({ where: { id: ctx.sessionId }, data: { status: "PREVIEWING" } });
    uploadHold = null;
    hold.resolve();
    const res = await pending;
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
    expect(await itemCount(ctx.workspaceId)).toBe(0);
    const intent = await intentRow(refs.intentId);
    expect(intent.status).toBe("FINALIZING"); // FAILED / FINALIZED いずれにも遷移しない
  });

  it("55) attemptToken 喪失: stale worker は後続 Storage write / DB 確定とも不可", async () => {
    const ctx = await makeCase("c55");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg");
    const takeover = crypto.randomUUID();
    const hold = makeHold();
    uploadHold = hold.promise;
    const pending = post({ intentId: refs.intentId });
    await waitFor(() => uploadCalls.length >= 1); // canonical PUT in-flight
    // 他 worker による lease 回収を再現（token を差し替え・lease は有効）
    await prisma.uploadIntent.update({
      where: { id: refs.intentId },
      data: { finalizeAttemptToken: takeover, finalizeLeaseUntil: new Date(Date.now() + FINALIZE_LEASE_MS) },
    });
    uploadHold = null;
    hold.resolve();
    const res = await pending;
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("FINALIZE_IN_PROGRESS");
    // stale worker は variant PUT を開始していない（canonical 1 回のみ）
    expect(uploadCalls).toHaveLength(1);
    expect(await itemCount(ctx.workspaceId)).toBe(0);
    const intent = await intentRow(refs.intentId);
    expect(intent.status).toBe("FINALIZING");
    expect(intent.finalizeAttemptToken).toBe(takeover); // 他 attempt の lease を解放していない
  });

  it("55a) token 喪失後の transient exit は他 attempt の lease / token を解放しない", async () => {
    const ctx = await makeCase("c55a");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg");
    const takeover = crypto.randomUUID();
    const takeoverLease = new Date(Date.now() + FINALIZE_LEASE_MS);
    const hold = makeHold();
    uploadHold = hold.promise;
    const pending = post({ intentId: refs.intentId });
    await waitFor(() => uploadCalls.length >= 1); // canonical PUT in-flight
    // 他 worker の回収 + この worker の PUT を transient 失敗にする
    await prisma.uploadIntent.update({
      where: { id: refs.intentId },
      data: { finalizeAttemptToken: takeover, finalizeLeaseUntil: takeoverLease },
    });
    uploadOverride = (path) =>
      path === refs.canonicalPath("jpg") ? { error: storageApiError(503, "503", "busy") } : null;
    uploadHold = null;
    hold.resolve();
    const res = await pending;
    expect(res.status).toBe(500);
    // token 条件付き release は count=0 の no-op — 他 attempt の lease を壊さない
    const intent = await intentRow(refs.intentId);
    expect(intent.status).toBe("FINALIZING");
    expect(intent.finalizeAttemptToken).toBe(takeover);
    expect(intent.finalizeLeaseUntil!.getTime()).toBe(takeoverLease.getTime());
    expect(await itemCount(ctx.workspaceId)).toBe(0);
  });

  it("56) membership 剥奪 race: final tx が拒否し UploadItem 0・403", async () => {
    const ctx = await makeCase("c56");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg");
    const hold = makeHold();
    uploadHold = hold.promise;
    const pending = post({ intentId: refs.intentId });
    await waitFor(() => uploadCalls.length >= 1);
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: ctx.workspaceId } });
    uploadHold = null;
    hold.resolve();
    const res = await pending;
    expect(res.status).toBe(403);
    expect(await itemCount(ctx.workspaceId)).toBe(0);
    const intent = await intentRow(refs.intentId);
    expect(intent.status).toBe("FINALIZING"); // FINALIZED になっていない（atomic 拒否）
  });

  // ---- measurement ----------------------------------------------------------

  async function expectMeasurementFatal(
    label: string,
    bytes: Buffer,
    mime: string,
    over: Partial<Prisma.UploadIntentUncheckedCreateInput>,
    expectedHttp: number,
    expectedCode: string,
    expectedLastError: string,
  ) {
    const ctx = await makeCase(label);
    const refs = await makeIntent(ctx, bytes, mime, over);
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(expectedHttp);
    const body = await res.json();
    expect(body.error.code).toBe(expectedCode);
    const intent = await intentRow(refs.intentId);
    expect(intent.status).toBe("FAILED");
    expect(intent.lastErrorCode).toBe(expectedLastError);
    expect(intent.failedAt).not.toBeNull();
    expect(intent.finalizeLeaseUntil).toBeNull();
    expect(intent.finalizeAttemptToken).toBeNull();
    // staging object は削除しない（B3c sweep へ委譲）
    expect(objectStore.has(refs.stagingPath)).toBe(true);
    expect(await itemCount(ctx.workspaceId)).toBe(0);
    return body;
  }

  it("60) zero byte object は 400 VALIDATION_ERROR / FAILED(EMPTY_OBJECT)", async () => {
    await expectMeasurementFatal("c60", Buffer.alloc(0), "image/jpeg", { declaredSizeBytes: 0 }, 400, "VALIDATION_ERROR", "EMPTY_OBJECT");
  });

  it("61) MAX_ORIGINAL_BYTES 超過は 413 PAYLOAD_TOO_LARGE / FAILED", async () => {
    const oversize = Buffer.alloc(MAX_ORIGINAL_BYTES + 1);
    await expectMeasurementFatal("c61", oversize, "image/jpeg", { declaredSizeBytes: oversize.length }, 413, "PAYLOAD_TOO_LARGE", "PAYLOAD_TOO_LARGE");
  });

  it("62) declared size mismatch は 400 VALIDATION_ERROR / FAILED", async () => {
    await expectMeasurementFatal("c62", jpeg40x20, "image/jpeg", { declaredSizeBytes: jpeg40x20.length + 1 }, 400, "VALIDATION_ERROR", "DECLARED_SIZE_MISMATCH");
  });

  it("63) 未対応バイト列（text）は 415 UNSUPPORTED_MEDIA_TYPE / FAILED", async () => {
    const text = Buffer.from("this is not an image at all, just plain text bytes");
    await expectMeasurementFatal("c63", text, "image/jpeg", {}, 415, "UNSUPPORTED_MEDIA_TYPE", "UNSUPPORTED_MEDIA_TYPE");
  });

  it("64) MIME mismatch（png bytes を jpeg 申告）は 400 VALIDATION_ERROR / FAILED", async () => {
    await expectMeasurementFatal("c64", png10x10, "image/jpeg", {}, 400, "VALIDATION_ERROR", "MIME_MISMATCH");
  });

  it("65) hash mismatch は 400 FILE_HASH_MISMATCH / FAILED", async () => {
    await expectMeasurementFatal("c65", jpeg40x20, "image/jpeg", { clientFileHash: "0".repeat(64) }, 400, "FILE_HASH_MISMATCH", "FILE_HASH_MISMATCH");
  });

  it("66) 壊れ画像（truncated JPEG）は 400 INVALID_IMAGE / FAILED・sharp raw error 非露出", async () => {
    const body = await expectMeasurementFatal("c66", corruptJpeg, "image/jpeg", {}, 400, "INVALID_IMAGE", "INVALID_IMAGE");
    // 固定文のみ（sharp の message / stack を含まない）
    expect(JSON.stringify(body)).not.toMatch(/sharp|vips|premature/i);
  });

  it("67) animated WebP は 415 UNSUPPORTED_MEDIA_TYPE / FAILED(ANIMATED_IMAGE_UNSUPPORTED)", async () => {
    await expectMeasurementFatal("c67", animatedWebp, "image/webp", {}, 415, "UNSUPPORTED_MEDIA_TYPE", "ANIMATED_IMAGE_UNSUPPORTED");
  });

  it("68) pixel 上限超過分類は 413 IMAGE_TOO_LARGE_PIXELS / FAILED（route mapping）", async () => {
    // 64MP 実画像は生成しない（B3a 方針）。route の mapping / 遷移だけを
    // measurement mock で固定する（B3a 側の境界は unit test が正本）。
    vi.resetModules();
    vi.doMock("@/lib/upload/finalizeMeasurement", async (importOriginal) => {
      const actual = (await importOriginal()) as typeof import("@/lib/upload/finalizeMeasurement");
      return {
        ...actual,
        measureStagedImage: async () => ({ ok: false as const, reason: "IMAGE_TOO_LARGE_PIXELS" as const }),
      };
    });
    try {
      const { POST: mockedPOST } = await import("./route");
      const ctx = await makeCase("c68");
      const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg");
      const req = new Request("http://localhost/api/uploads/items/finalize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intentId: refs.intentId }),
      });
      const res = await mockedPOST(req as unknown as Parameters<RoutePOST>[0]);
      expect(res.status).toBe(413);
      expect((await res.json()).error.code).toBe("IMAGE_TOO_LARGE_PIXELS");
      const intent = await intentRow(refs.intentId);
      expect(intent.status).toBe("FAILED");
      expect(intent.lastErrorCode).toBe("IMAGE_TOO_LARGE_PIXELS");
    } finally {
      vi.doUnmock("@/lib/upload/finalizeMeasurement");
      vi.resetModules();
    }
  });

  // ---- canonical ------------------------------------------------------------

  it("70) 既存 canonicalOriginalPath が同一なら冪等継続で 201", async () => {
    const ctx = await makeCase("c70");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg");
    await prisma.uploadIntent.update({
      where: { id: refs.intentId },
      data: { canonicalOriginalPath: refs.canonicalPath("jpg") },
    });
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(201);
  });

  it("71) 既存 canonicalOriginalPath が異なる場合は conflict（PUT 開始せず FAILED）500", async () => {
    const ctx = await makeCase("c71");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg");
    await prisma.uploadIntent.update({
      where: { id: refs.intentId },
      data: { canonicalOriginalPath: refs.canonicalPath("png") }, // 決定的 measurement と矛盾
    });
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("INTERNAL_ERROR");
    const intent = await intentRow(refs.intentId);
    expect(intent.status).toBe("FAILED");
    expect(intent.lastErrorCode).toBe("CANONICAL_PATH_CONFLICT");
    expect(uploadCalls).toHaveLength(0); // Storage PUT を開始していない
    expect(await itemCount(ctx.workspaceId)).toBe(0);
  });

  it("72) canonical Already-Exists + 3 条件一致は再検証のうえ冪等成功 201", async () => {
    const ctx = await makeCase("c72");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg");
    // 前 attempt の残骸を再現（同一 bytes）
    objectStore.set(refs.canonicalPath("jpg"), { bytes: jpeg40x20, contentType: "image/jpeg" });
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(201);
    // 検証のため canonical を再 download している
    expect(downloadCalls).toContain(refs.canonicalPath("jpg"));
    expect((await intentRow(refs.intentId)).status).toBe("FINALIZED");
  });

  it("73) canonical Already-Exists + 内容不一致（別画像）は conflict・上書きなし・FAILED 500", async () => {
    const ctx = await makeCase("c73");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg");
    objectStore.set(refs.canonicalPath("jpg"), { bytes: png10x10, contentType: "image/png" });
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("INTERNAL_ERROR");
    const intent = await intentRow(refs.intentId);
    expect(intent.status).toBe("FAILED");
    expect(intent.lastErrorCode).toBe("CANONICAL_OBJECT_CONFLICT");
    // 競合 object は保全（上書き・remove しない）
    expect(objectStore.get(refs.canonicalPath("jpg"))!.bytes.equals(png10x10)).toBe(true);
    expect(await itemCount(ctx.workspaceId)).toBe(0);
  });

  it("74) canonical Already-Exists + 同サイズ hash 不一致も conflict（hash 照合が効く）", async () => {
    const ctx = await makeCase("c74");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg");
    // 同一長・magic bytes 維持・末尾 1 byte 改変 = size/mime 一致・hash のみ不一致
    const tampered = Buffer.from(jpeg40x20);
    tampered[tampered.length - 1] ^= 0xff;
    objectStore.set(refs.canonicalPath("jpg"), { bytes: tampered, contentType: "image/jpeg" });
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(500);
    const intent = await intentRow(refs.intentId);
    expect(intent.status).toBe("FAILED");
    expect(intent.lastErrorCode).toBe("CANONICAL_OBJECT_CONFLICT");
    expect(objectStore.get(refs.canonicalPath("jpg"))!.bytes.equals(tampered)).toBe(true);
  });

  it("74b) fatal transition直前にattemptTokenを失ったworkerは新attemptをFAILED化できない", async () => {
    // canonical Already-Exists 再検証（fatal conflict 確定）の直前で barrier し、
    // その間に他 worker が新 attemptToken + 新 lease で回収したと仮定する。旧
    // worker が fatalExit（failIntentWithToken）へ到達しても、新 attempt の
    // FINALIZING/lease を破壊できないことを固定する。この経路には canonical PUT
    // 後から fatalExit までの間に ownsAttempt() 再確認が存在しない（測定前・
    // canonical PUT 前・variant PUT 前・final tx 前の 4 点のみ）ため、
    // failIntentWithToken 内の attemptToken 条件が単独で防御の全てを担う。
    const ctx = await makeCase("fatalTok");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg");
    // 内容不一致の既存 canonical object を先に置く（test 73 と同型）→ canonical PUT
    // は Already-Exists → 再 download 検証 → mismatch → fatal conflict へ向かう。
    objectStore.set(refs.canonicalPath("jpg"), { bytes: png10x10, contentType: "image/png" });

    const stolenToken = crypto.randomUUID();
    const stolenLease = new Date(Date.now() + FINALIZE_LEASE_MS);
    const hold = makeHold();
    downloadHoldPath = refs.canonicalPath("jpg"); // staging download は素通し・canonical 再検証だけ hold
    downloadHold = hold.promise;

    const pending = post({ intentId: refs.intentId });
    await waitFor(() => downloadCalls.includes(refs.canonicalPath("jpg")));

    // 他 worker による回収を再現: token と lease を新しい未来値へ差し替える。
    await prisma.uploadIntent.update({
      where: { id: refs.intentId },
      data: { finalizeAttemptToken: stolenToken, finalizeLeaseUntil: stolenLease },
    });

    downloadHoldPath = null;
    downloadHold = null;
    hold.resolve();
    const res = await pending;

    // candidate の既存再分類契約に従う: FINALIZING・lease 有効 → 409 FINALIZE_IN_PROGRESS
    // （token 喪失後の一般契約。test 55 と同型の収束先）。一般 500 へ弱めない。
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("FINALIZE_IN_PROGRESS");

    const intent = await intentRow(refs.intentId);
    // 旧 worker は FAILED化・token clear・lease clear・lastError 書換えのいずれも
    // 行えていない — 新 attempt の状態がそのまま残る。
    expect(intent.status).toBe("FINALIZING");
    expect(intent.status).not.toBe("FAILED");
    expect(intent.finalizeAttemptToken).toBe(stolenToken);
    expect(intent.finalizeLeaseUntil!.getTime()).toBe(stolenLease.getTime());
    expect(intent.lastErrorCode).not.toBe("CANONICAL_OBJECT_CONFLICT");
    expect(intent.failedAt).toBeNull();
    expect(await itemCount(ctx.workspaceId)).toBe(0);
  });

  it("75) canonical PUT transient は 500・FINALIZING 維持・lease 解放・同一 intent で retry 成功", async () => {
    const ctx = await makeCase("c75");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg");
    uploadOverride = (path) =>
      path === refs.canonicalPath("jpg") ? { error: storageApiError(503, "503", "backend busy detail") } : null;
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(json)).not.toContain("backend busy");
    const intent = await intentRow(refs.intentId);
    expect(intent.status).toBe("FINALIZING"); // PREPARED へ戻さない
    expect(intent.finalizeLeaseUntil).toBeNull(); // 即時解放で retry 可能
    expect(intent.finalizeAttemptToken).toBeNull();
    expect(intent.lastErrorCode).toBe("CANONICAL_WRITE_FAILED");

    // retry（override 解除）→ stale FINALIZING 回収 → 201
    uploadOverride = null;
    const retry = await post({ intentId: refs.intentId });
    expect(retry.status).toBe(201);
    expect((await intentRow(refs.intentId)).status).toBe("FINALIZED");
  });

  it("76) canonical PUT 後の DB 失敗は rollback（FINALIZED 単独なし）→ retry が Already-Exists 経由で 201", async () => {
    const ctx = await makeCase("c76");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg");
    // reserved ID を先に占有して final tx の create を P2002 で落とす
    await makeItemRow(ctx, refs, { sortOrder: 99, fileHash: "c".repeat(64) });
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("INTERNAL_ERROR");
    const intent = await intentRow(refs.intentId);
    // atomicity: FINALIZED だけが単独 commit されることはない（rollback 済み）
    expect(intent.status).toBe("FINALIZING");
    expect(intent.uploadItemId).toBeNull();
    expect(intent.lastErrorCode).toBe("DB_TRANSACTION_FAILED");
    expect(intent.finalizeLeaseUntil).toBeNull();
    // canonical object は PUT 済みのまま残る（削除しない）
    expect(objectStore.has(refs.canonicalPath("jpg"))).toBe(true);

    // 占有 row を除去して retry → canonical Already-Exists → 検証一致 → 201
    await prisma.uploadItem.deleteMany({ where: { id: refs.reservedUploadItemId } });
    const retry = await post({ intentId: refs.intentId });
    expect(retry.status).toBe(201);
    const after = await intentRow(refs.intentId);
    expect(after.status).toBe("FINALIZED");
    expect(after.uploadItemId).toBe(refs.reservedUploadItemId);
    expect(await itemCount(ctx.workspaceId)).toBe(1);
  });

  // ---- variants --------------------------------------------------------------

  it("80) unknown variant profile は両 variant null のまま READY / 201（variant PUT なし）", async () => {
    const ctx = await makeCase("c80");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg", { variantProfileVersion: "v999" });
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.item.uploadStatus).toBe("READY");
    expect(json.data.item.tempThumbnailPath).toBeNull();
    expect(json.data.item.tempPreviewPath).toBeNull();
    // canonical のみ（variant PUT なし・既存 variant を信用した path 保存もない）
    expect(uploadCalls.map((c) => c.path)).toEqual([refs.canonicalPath("jpg")]);
  });

  it("81) thumbnail PUT 失敗は nonfatal: thumbnail null / preview 保持・fallback signed URL", async () => {
    const ctx = await makeCase("c81");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg");
    uploadOverride = (path) =>
      path === refs.thumbnailPath ? { error: storageApiError(500, "500", "thumb put failed") } : null;
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.item.tempThumbnailPath).toBeNull();
    expect(json.data.item.tempPreviewPath).toBe(refs.previewPath); // 一方失敗でも他方を保持
    expect(json.data.item.uploadStatus).toBe("READY");
    // thumbnail は preview へ fallback して signed URL が出る
    expect(json.data.signedUrls.thumbnail.signedUrl).toContain(refs.previewPath);
    expect(json.data.signedUrls.thumbnail.fallback).toBe(true);
    expect((await intentRow(refs.intentId)).status).toBe("FINALIZED"); // fatal 化しない
  });

  it("82) preview PUT 失敗は nonfatal: preview null / thumbnail 保持", async () => {
    const ctx = await makeCase("c82");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg");
    uploadOverride = (path) =>
      path === refs.previewPath ? { error: storageApiError(500, "500", "preview put failed") } : null;
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.item.tempThumbnailPath).toBe(refs.thumbnailPath);
    expect(json.data.item.tempPreviewPath).toBeNull();
    // preview は original へ fallback
    expect(json.data.signedUrls.preview.fallback).toBe(true);
  });

  it("83) 両 variant PUT 失敗でも original READY で 201", async () => {
    const ctx = await makeCase("c83");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg");
    uploadOverride = (path) =>
      path === refs.thumbnailPath || path === refs.previewPath
        ? { error: storageApiError(500, "500", "variant backend down") }
        : null;
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.item.tempThumbnailPath).toBeNull();
    expect(json.data.item.tempPreviewPath).toBeNull();
    expect(json.data.item.uploadStatus).toBe("READY");
    expect(JSON.stringify(json)).not.toContain("variant backend down");
  });

  it("84) variant encode 失敗（生成段階）は個別 nonfatal・PUT は成功 variant のみ", async () => {
    vi.resetModules();
    let variantResult: (webp: Buffer) => {
      profileKnown: boolean;
      thumbnail: { ok: true; buffer: Buffer; mimeType: "image/webp"; width: number; height: number } | { ok: false; reason: "GENERATION_FAILED" };
      preview: { ok: true; buffer: Buffer; mimeType: "image/webp"; width: number; height: number } | { ok: false; reason: "GENERATION_FAILED" };
    } = (webp) => ({
      profileKnown: true,
      thumbnail: { ok: false, reason: "GENERATION_FAILED" },
      preview: { ok: true, buffer: webp, mimeType: "image/webp", width: 16, height: 8 },
    });
    vi.doMock("@/lib/upload/variantProfile", async (importOriginal) => {
      const actual = (await importOriginal()) as typeof import("@/lib/upload/variantProfile");
      return { ...actual, generateVariants: async () => variantResult(webp16x8) };
    });
    try {
      const { POST: mockedPOST } = await import("./route");
      const mockedPost = async (intentId: string) => {
        const req = new Request("http://localhost/api/uploads/items/finalize", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ intentId }),
        });
        return mockedPOST(req as unknown as Parameters<RoutePOST>[0]);
      };

      // thumbnail encode 失敗 → thumbnail PUT なし・preview のみ PUT
      const ctx1 = await makeCase("c84a");
      const refs1 = await makeIntent(ctx1, jpeg40x20, "image/jpeg");
      const res1 = await mockedPost(refs1.intentId);
      expect(res1.status).toBe(201);
      const json1 = await res1.json();
      expect(json1.data.item.tempThumbnailPath).toBeNull();
      expect(json1.data.item.tempPreviewPath).toBe(refs1.previewPath);
      expect(uploadCalls.map((c) => c.path)).not.toContain(refs1.thumbnailPath);
      await cleanupNamespace(ctx1.workspaceId);
      currentCaseWorkspaceId = null;
      resetKnobs();

      // 両 encode 失敗 → variant PUT ゼロ・READY 維持
      variantResult = () => ({
        profileKnown: true,
        thumbnail: { ok: false, reason: "GENERATION_FAILED" },
        preview: { ok: false, reason: "GENERATION_FAILED" },
      });
      const ctx2 = await makeCase("c84b");
      const refs2 = await makeIntent(ctx2, jpeg40x20, "image/jpeg");
      const res2 = await mockedPost(refs2.intentId);
      expect(res2.status).toBe(201);
      const json2 = await res2.json();
      expect(json2.data.item.tempThumbnailPath).toBeNull();
      expect(json2.data.item.tempPreviewPath).toBeNull();
      expect(json2.data.item.uploadStatus).toBe("READY");
      expect(uploadCalls.map((c) => c.path)).toEqual([refs2.canonicalPath("jpg")]);
      expect((await intentRow(refs2.intentId)).status).toBe("FINALIZED");
      expect(JSON.stringify(json2)).not.toContain("GENERATION_FAILED");
    } finally {
      vi.doUnmock("@/lib/upload/variantProfile");
      vi.resetModules();
    }
  });

  // ---- duplicate check --------------------------------------------------------

  it("90) 既存 active Image と同 hash は DUPLICATE + duplicateImageId", async () => {
    const ctx = await makeCase("c90");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg");
    const imageId = `${ctx.workspaceId}img`;
    await prisma.image.create({
      data: {
        id: imageId,
        workspaceId: ctx.workspaceId,
        storagePath: `${ctx.workspaceId}/assets/${imageId}/original.jpg`,
        originalName: "dup.jpg",
        originalExt: "jpg",
        mimeType: "image/jpeg",
        fileSizeBytes: jpeg40x20.length,
        fileHash: sha256(jpeg40x20),
      },
    });
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.item.duplicateStatus).toBe("DUPLICATE");
    expect(json.data.item.duplicateImageId).toBe(imageId);
  });

  it("91) soft-deleted / DELETED Image は duplicate として扱わない（CLEAN）", async () => {
    const ctx = await makeCase("c91");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg");
    const imageId = `${ctx.workspaceId}img`;
    await prisma.image.create({
      data: {
        id: imageId,
        workspaceId: ctx.workspaceId,
        status: "DELETED",
        deletedAt: new Date(),
        storagePath: `${ctx.workspaceId}/assets/${imageId}/original.jpg`,
        originalName: "dup.jpg",
        originalExt: "jpg",
        mimeType: "image/jpeg",
        fileSizeBytes: jpeg40x20.length,
        fileHash: sha256(jpeg40x20),
      },
    });
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.item.duplicateStatus).toBe("CLEAN");
    expect(json.data.item.duplicateImageId).toBeNull();
  });

  // ---- response ----------------------------------------------------------------

  it("95) signed URL 発行失敗は nonfatal: 201 のまま signedUrl:null 固定 shape", async () => {
    const ctx = await makeCase("c95");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg");
    signedUrlBehaviour = "error";
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(201);
    const json = await res.json();
    for (const variant of ["thumbnail", "preview", "original"] as const) {
      expect(json.data.signedUrls[variant]).toEqual({ signedUrl: null, fallback: null });
    }
    expect((await intentRow(refs.intentId)).status).toBe("FINALIZED");
    expect(await itemCount(ctx.workspaceId)).toBe(1);
  });

  it("96) error response には path / hash / provider detail を含まない", async () => {
    const ctx = await makeCase("c96");
    const refs = await makeIntent(ctx, jpeg40x20, "image/jpeg", { clientFileHash: "0".repeat(64) });
    const res = await post({ intentId: refs.intentId });
    expect(res.status).toBe(400);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("upload-intents");
    expect(text).not.toContain(ctx.workspaceId);
    expect(text).not.toContain(sha256(jpeg40x20));
    expect(text).not.toContain("0".repeat(64));
  });
});
