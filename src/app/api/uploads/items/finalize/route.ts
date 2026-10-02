import "server-only";

export const dynamic = "force-dynamic";
// node:crypto (randomUUID) / sharp を使うため Node.js runtime 固定。
export const runtime = "nodejs";
// 承認済み（B3b-2 Start Gate）。lease(120s) > maxDuration(60s) を維持する。
export const maxDuration = 60;

// Phase 10-43-B3b-2: POST /api/uploads/items/finalize
//
// staging object を server 実測で検証し、canonical namespace へ確定して
// UploadItem を作成する。分類ロジックは B3b-1 の pure core
// (finalizeLifecycle / storageErrors) を唯一の正本として使い、route は
// その決定に従って副作用を実行するだけにする（state machine を再実装しない）。
//
// 順序の要点（Frozen Plan §5 案A / §8 / §9）:
// - staging download は lease CAS より前。PREPARED + object missing は
//   PREPARED のまま 409 OBJECT_MISSING（FINALIZING → PREPARED は存在しない）
// - canonicalOriginalPath は Storage PUT より前に DB へ保存する
//   （crash しても DB 起点で object を追跡できる）
// - canonical Already-Exists は既存 object を再 download + 再実測で検証し、
//   size/mime/hash 完全一致のときだけ冪等成功（上書きはしない）
// - stale worker は attemptToken 条件の updateMany が 0 件になることで
//   DB 確定から構造的に排除される

import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { err, okNoStore, Errors } from "@/lib/apiResponse";
import { createPerfLog } from "@/lib/perfLog";
import { checkUserRateLimit, rateLimitHeaders } from "@/lib/rateLimit";
import { authorizeSession, ITEM_SELECT } from "@/lib/uploadSession";
import { readDirectUploadEnabledFlag } from "@/lib/upload/directUploadFeature";
import { isJsonContentType } from "@/lib/upload/preparePayload";
import { parseFinalizePayload } from "@/lib/upload/finalizePayload";
import { tempOriginalPath, tempThumbnailPath, tempPreviewPath } from "@/lib/upload/storagePaths";
import {
  FINALIZE_LEASE_MS,
  isLeaseActive,
  sanitizeErrorCode,
  sanitizeErrorDetail,
  type UploadIntentStatusValue,
} from "@/lib/upload/uploadIntentCore";
import {
  classifyIntentForFinalize,
  classifyStagingObjectMissing,
  decideCanonicalConflict,
  mapMeasurementFailure,
  mapTransientFailure,
  summarizeVariantOutcomes,
  type FinalizeRejection,
  type TransientStage,
} from "@/lib/upload/finalizeLifecycle";
// sharp を静的 import graph へ載せないため、この 2 module からは型だけを取る
// （実体は POST 内の loadImageRuntime() が動的に読む。Frozen Plan §79-8）。
import type {
  FinalizeMeasurementFailureReason,
  MeasuredImage,
} from "@/lib/upload/finalizeMeasurement";
import type { VariantOutcome } from "@/lib/upload/variantProfile";
import { normalizeStorageError } from "@/lib/upload/storageErrors";
import { resolveSignedUrl } from "@/lib/signedUrl";

const BUCKET = "photobox-private";

// finalize の判定に必要な最小 select。token / hash / path は response へ出さない。
const INTENT_SELECT = {
  id: true,
  workspaceId: true,
  sessionId: true,
  userId: true,
  status: true,
  declaredOriginalName: true,
  declaredMimeType: true,
  declaredSizeBytes: true,
  clientFileHash: true,
  stagingOriginalPath: true,
  canonicalOriginalPath: true,
  reservedUploadItemId: true,
  reservedSortOrder: true,
  variantProfileVersion: true,
  intentFinalizeDeadlineAt: true,
  finalizeStartedAt: true,
  finalizeLeaseUntil: true,
  finalizeAttemptCount: true,
  finalizeAttemptToken: true,
  cleanupLeaseUntil: true,
  uploadItemId: true,
  lastErrorCode: true,
  lastErrorDetail: true,
} as const;

type IntentRow = {
  id: string;
  workspaceId: string;
  sessionId: string;
  userId: string;
  status: UploadIntentStatusValue;
  declaredOriginalName: string;
  declaredMimeType: string;
  declaredSizeBytes: number;
  clientFileHash: string;
  stagingOriginalPath: string;
  canonicalOriginalPath: string | null;
  reservedUploadItemId: string;
  reservedSortOrder: number;
  variantProfileVersion: string;
  intentFinalizeDeadlineAt: Date;
  finalizeStartedAt: Date | null;
  finalizeLeaseUntil: Date | null;
  finalizeAttemptCount: number;
  finalizeAttemptToken: string | null;
  cleanupLeaseUntil: Date | null;
  uploadItemId: string | null;
  lastErrorCode: string | null;
  lastErrorDetail: string | null;
};

type SessionStateRow = {
  status: string;
  cleanupLeaseUntil: Date | null;
};

// canonicalOriginalPath 保存時の不一致（決定的 measurement と矛盾する既存値 =
// 外部干渉）。B3b-1 に factory がない唯一の fatal mapping（Frozen Plan §12）。
const CANONICAL_PATH_CONFLICT: FinalizeRejection = {
  kind: "reject",
  http: 500,
  errorCode: "INTERNAL_ERROR",
  message: "Failed to finalize the upload. Please start a new upload.",
  retryable: false,
  intentTransition: "fail",
  lastErrorCode: "CANONICAL_PATH_CONFLICT",
  lastErrorDetail: "Stored canonical path does not match the measured path",
  releaseLease: true,
};

// image 実行環境（sharp native binding + libvips）が Function bundle 上で
// 解決できない場合の固定応答。lease 未取得地点でのみ使うため transition は
// "none"（DB write 0 / lease 操作 0）。native path / package 名 / raw error は
// message へ一切含めない（Frozen Plan §79-8）。
const IMAGE_RUNTIME_UNAVAILABLE: FinalizeRejection = {
  kind: "reject",
  http: 500,
  errorCode: "INTERNAL_ERROR",
  message: "Failed to finalize the upload. Please try again later.",
  retryable: true,
  intentTransition: "none",
  lastErrorCode: "IMAGE_RUNTIME_UNAVAILABLE",
  lastErrorDetail: "Image processing runtime is unavailable",
  releaseLease: false,
};

const rejectionResponse = (r: FinalizeRejection) => err(r.errorCode, r.message, r.http);

// ---------------------------------------------------------------------------
// image runtime lazy loader（Frozen Plan §79-4 / §79-8）
//
// sharp は native binding + 共有 library に依存する。これを module scope で
// 解決すると load 失敗が route module 全体を落とし、POST 先頭の feature flag
// gate（404）へ到達できなくなる（B4 P0-C3 の実障害）。measurement / variant の
// 両 module をここでまとめて動的 import し、片方だけ成功した状態では続行しない。
// raw import error は外へ throw せず握り潰し、呼び出し側は固定 rejection だけを
// 返す。module scope では実行しない（loader は POST 内からのみ呼ぶ）。
// ---------------------------------------------------------------------------

type ImageRuntime = {
  measureStagedImage: (typeof import("@/lib/upload/finalizeMeasurement"))["measureStagedImage"];
  generateVariants: (typeof import("@/lib/upload/variantProfile"))["generateVariants"];
};

async function loadImageRuntime(): Promise<ImageRuntime | null> {
  // Promise.all の一括 reject で片側が unhandled rejection になるのを避けるため、
  // 個別に catch して null へ落とす（両方の評価を必ず試行する）。
  const [measurement, variant] = await Promise.all([
    import("@/lib/upload/finalizeMeasurement").catch(() => null),
    import("@/lib/upload/variantProfile").catch(() => null),
  ]);
  if (measurement === null || variant === null) return null;
  if (
    typeof measurement.measureStagedImage !== "function" ||
    typeof variant.generateVariants !== "function"
  ) {
    return null;
  }
  // Production entry point のみを渡す（*ForTest entry は返さない）。
  return {
    measureStagedImage: measurement.measureStagedImage,
    generateVariants: variant.generateVariants,
  };
}

const cleanupInactive = (now: Date) => ({
  OR: [{ cleanupLeaseUntil: null }, { cleanupLeaseUntil: { lte: now } }],
});

async function readIntent(intentId: string): Promise<IntentRow | null> {
  return (await prisma.uploadIntent.findUnique({
    where: { id: intentId },
    select: INTENT_SELECT,
  })) as IntentRow | null;
}

async function readSessionState(sessionId: string): Promise<SessionStateRow | null> {
  return prisma.uploadSession.findUnique({
    where: { id: sessionId },
    select: { status: true, cleanupLeaseUntil: true },
  });
}

async function readUploadItemExists(intent: IntentRow): Promise<boolean> {
  if (intent.status !== "FINALIZED" || intent.uploadItemId === null) return false;
  const count = await prisma.uploadItem.count({
    where: { id: intent.uploadItemId, workspaceId: intent.workspaceId },
  });
  return count > 0;
}

// deadline 超過時の guarded EXPIRE（prepare route と同型 + FINALIZING の
// stale lease も対象。isPastFinalizeDeadline と同じ「now > deadline」境界）。
async function applyExpireTransition(intentId: string, now: Date): Promise<boolean> {
  const expired = await prisma.uploadIntent.updateMany({
    where: {
      id: intentId,
      status: { in: ["PREPARED", "FINALIZING"] },
      intentFinalizeDeadlineAt: { lt: now },
      OR: [{ finalizeLeaseUntil: null }, { finalizeLeaseUntil: { lte: now } }],
      AND: [cleanupInactive(now)],
    },
    data: { status: "EXPIRED" },
  });
  return expired.count > 0;
}

// attemptToken 所有時のみ成立する fatal 遷移。count=0 = stale worker で、
// その場合呼び出し元は DB 確定済みの response を返してはならない。
async function failIntentWithToken(
  intentId: string,
  attemptToken: string,
  rejection: FinalizeRejection,
  now: Date,
): Promise<boolean> {
  const failed = await prisma.uploadIntent.updateMany({
    where: { id: intentId, status: "FINALIZING", finalizeAttemptToken: attemptToken },
    data: {
      status: "FAILED",
      failedAt: now,
      lastErrorCode: sanitizeErrorCode(rejection.lastErrorCode ?? null),
      lastErrorDetail: sanitizeErrorDetail(rejection.lastErrorDetail ?? null),
      finalizeLeaseUntil: null,
      finalizeAttemptToken: null,
    },
  });
  return failed.count > 0;
}

// transient 失敗時の lease 即時解放。status は FINALIZING のまま
// （FINALIZING → PREPARED は存在しない）。token 条件により他 attempt の
// lease を解放することはない。書込み失敗しても 120s で自然失効するため
// best-effort。エラーコード未指定時は lastError を変更しない。
async function releaseLeaseWithToken(
  intentId: string,
  attemptToken: string,
  lastErrorCode?: string,
  lastErrorDetail?: string,
): Promise<void> {
  await prisma.uploadIntent
    .updateMany({
      where: { id: intentId, status: "FINALIZING", finalizeAttemptToken: attemptToken },
      data: {
        finalizeLeaseUntil: null,
        finalizeAttemptToken: null,
        ...(lastErrorCode !== undefined
          ? {
              lastErrorCode: sanitizeErrorCode(lastErrorCode),
              lastErrorDetail: sanitizeErrorDetail(lastErrorDetail ?? null),
            }
          : {}),
      },
    })
    .catch(() => undefined);
}

// stage 境界の attempt 所有権確認（Frozen Plan §8-2 / 指示 §17）。
// lease 期限自体も確認に含める — correctness を platform timeout だけに
// 依存させない。所有権を失った worker は以後の Storage write / DB 確定を
// 開始してはならない。
async function ownsAttempt(intentId: string, attemptToken: string, now: Date): Promise<boolean> {
  const current = await prisma.uploadIntent.findUnique({
    where: { id: intentId },
    select: {
      status: true,
      userId: true,
      workspaceId: true,
      finalizeAttemptToken: true,
      finalizeLeaseUntil: true,
      cleanupLeaseUntil: true,
      session: { select: { status: true, cleanupLeaseUntil: true, userId: true, workspaceId: true } },
    },
  });
  if (!current) return false;
  if (current.status !== "FINALIZING") return false;
  if (current.finalizeAttemptToken !== attemptToken) return false;
  if (!isLeaseActive(current.finalizeLeaseUntil, now)) return false;
  if (isLeaseActive(current.cleanupLeaseUntil, now)) return false;
  const session = current.session;
  if (!session || session.status !== "ACTIVE") return false;
  if (isLeaseActive(session.cleanupLeaseUntil, now)) return false;
  if (session.userId !== current.userId || session.workspaceId !== current.workspaceId) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Response 構築（初回 201 / replay 200 で同一 data shape。multipart route 互換）
// ---------------------------------------------------------------------------

type SignedUrlEntry = { signedUrl: string | null; fallback: boolean | null };

async function buildSignedUrls(
  uploadItemId: string,
  userId: string,
): Promise<{ thumbnail: SignedUrlEntry; preview: SignedUrlEntry; original: SignedUrlEntry }> {
  const nullEntry: SignedUrlEntry = { signedUrl: null, fallback: null };
  try {
    const [thumb, preview, original] = await Promise.all([
      resolveSignedUrl("uploadItem", uploadItemId, "thumbnail", userId, 0),
      resolveSignedUrl("uploadItem", uploadItemId, "preview", userId, 1),
      resolveSignedUrl("uploadItem", uploadItemId, "original", userId, 2),
    ]);
    const entry = (r: (typeof thumb)): SignedUrlEntry =>
      "reason" in r ? nullEntry : { signedUrl: r.signedUrl, fallback: r.fallback };
    return { thumbnail: entry(thumb), preview: entry(preview), original: entry(original) };
  } catch {
    // signed URL 失敗は finalize 成功を取り消さない（nonfatal・固定 shape）。
    return { thumbnail: nullEntry, preview: nullEntry, original: nullEntry };
  }
}

async function buildItemResponse(uploadItemId: string, workspaceId: string, userId: string, httpStatus: 200 | 201) {
  const item = await prisma.uploadItem.findUnique({
    where: { id: uploadItemId },
    select: ITEM_SELECT,
  });
  // FINALIZED 直後〜fetch 間の hard delete race。正当な削除済み状態として 404。
  if (!item || item.workspaceId !== workspaceId) {
    return Errors.notFound("Upload item not found");
  }
  const signedUrls = await buildSignedUrls(uploadItemId, userId);
  return okNoStore({ item, signedUrls }, httpStatus);
}

// ---------------------------------------------------------------------------
// 再分類（CAS / guard の count=0 時。一般 500 へ潰さず最新契約で応答する）
// ---------------------------------------------------------------------------

async function respondByReclassification(
  intentId: string,
  userId: string,
  depth = 0,
): Promise<Response> {
  const latest = await readIntent(intentId);
  if (!latest) return Errors.notFound("Upload intent not found");
  if (latest.userId !== userId) return Errors.forbidden();

  const session = await readSessionState(latest.sessionId);
  const now = new Date();
  const uploadItemExists = await readUploadItemExists(latest);

  const classification = classifyIntentForFinalize({
    now,
    intent: {
      status: latest.status,
      intentFinalizeDeadlineAt: latest.intentFinalizeDeadlineAt,
      finalizeLeaseUntil: latest.finalizeLeaseUntil,
      cleanupLeaseUntil: latest.cleanupLeaseUntil,
      uploadItemId: latest.uploadItemId,
    },
    session,
    uploadItemExists,
  });

  if (classification.kind === "replay") {
    return buildItemResponse(latest.uploadItemId!, latest.workspaceId, userId, 200);
  }
  if (classification.kind === "proceed") {
    // 直前の CAS 失敗が純粋な race だった場合。ループせず retry 可能な 409 で返す。
    return err("CONFLICT", "Upload state changed during finalize. Please retry.", 409);
  }
  if (classification.intentTransition === "expire") {
    const expired = await applyExpireTransition(latest.id, now);
    if (!expired && depth < 2) return respondByReclassification(intentId, userId, depth + 1);
  }
  return rejectionResponse(classification);
}

// canonical Already-Exists 再検証の measurement 失敗 reason → 照合 boolean。
// measurement は size → MIME → hash → decode の順で short-circuit するため、
// decode 段の失敗（INVALID_IMAGE 等）に到達するのは size/mime/hash が全一致
// した後 = bytes 同一のときだけ（hash commitment）。その場合 3 条件 true の
// まま冪等成功へ倒れるのは安全（既存 object は staged bytes と同一）。
function canonicalMatchesFromFailure(reason: FinalizeMeasurementFailureReason) {
  return {
    sizeMatches: reason !== "EMPTY_OBJECT" && reason !== "PAYLOAD_TOO_LARGE" && reason !== "DECLARED_SIZE_MISMATCH",
    mimeMatches: reason !== "UNSUPPORTED_MEDIA_TYPE" && reason !== "MIME_MISMATCH",
    hashMatches: reason !== "FILE_HASH_MISMATCH",
  };
}

// ---------------------------------------------------------------------------
// POST /api/uploads/items/finalize
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const perf = createPerfLog("uploads.finalize");

  // ---- 0. direct upload gate（auth より前。無効時は認証状態に関わらず 404） --
  if (!readDirectUploadEnabledFlag()) {
    return err("NOT_FOUND", "Not found", 404);
  }

  // ---- 1. 認証 -----------------------------------------------------------
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();
  perf.mark("authMs");

  // ---- 2. rate limit（JSON parse より前・userId 単位） ---------------------
  const rl = await checkUserRateLimit({ preset: "uploadFinalize", userId: user.id });
  perf.mark("rateLimitMs");
  if (!rl.allowed) return Errors.rateLimited(rateLimitHeaders(rl));

  // ---- 3. JSON parse / exact-key validation ------------------------------
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return Errors.validation("Content-Type must be application/json");
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Errors.validation("Invalid JSON body");
  }
  const parsed = parseFinalizePayload(body);
  if (!parsed.ok) return Errors.validation(parsed.message);
  perf.mark("validateMs");

  // ---- 4. intent 取得 + 認可 ----------------------------------------------
  const intent = await readIntent(parsed.payload.intentId);
  if (!intent) return Errors.notFound("Upload intent not found");
  if (intent.userId !== user.id) return Errors.forbidden();

  const auth = await authorizeSession(intent.sessionId, user.id);
  if (!auth.ok) {
    return auth.reason === "NOT_FOUND" ? Errors.notFound("Session not found") : Errors.forbidden();
  }
  // 構造上 composite FK で一致が保証されるが、防御として安全側 403。
  if (auth.session.workspaceId !== intent.workspaceId) return Errors.forbidden();

  const sessionState = await readSessionState(intent.sessionId);
  perf.mark("authorizeMs");

  // ---- 5. read-side lifecycle 分類（B3b-1 が唯一の正本） -------------------
  const readNow = new Date();
  const uploadItemExists = await readUploadItemExists(intent);
  const classification = classifyIntentForFinalize({
    now: readNow,
    intent: {
      status: intent.status,
      intentFinalizeDeadlineAt: intent.intentFinalizeDeadlineAt,
      finalizeLeaseUntil: intent.finalizeLeaseUntil,
      cleanupLeaseUntil: intent.cleanupLeaseUntil,
      uploadItemId: intent.uploadItemId,
    },
    session: sessionState,
    uploadItemExists,
  });

  if (classification.kind === "replay") {
    // Storage download / upload / sharp / lease / DB write は一切行わない。
    perf.end({
      path: "replayed",
      intentId: intent.id,
      rateLimitEnabled: rl.enabled,
      rateLimitSource: rl.source,
    });
    return buildItemResponse(intent.uploadItemId!, intent.workspaceId, user.id, 200);
  }

  if (classification.kind === "reject") {
    if (classification.intentTransition === "expire") {
      const expired = await applyExpireTransition(intent.id, readNow);
      if (!expired) return respondByReclassification(intent.id, user.id);
    }
    perf.end({
      path: `rejected_${classification.errorCode.toLowerCase()}`,
      intentId: intent.id,
      rateLimitEnabled: rl.enabled,
      rateLimitSource: rl.source,
    });
    return rejectionResponse(classification);
  }

  const recoveredStaleLease = classification.recoveredStaleLease;

  // ---- 6. staging download（lease CAS より前 — Frozen Plan §5 案A） --------
  // 非 StorageError は {data,error} で返らず throw されるため try/catch 必須。
  let downloadFailure: unknown = null;
  let stagingBlob: Blob | null = null;
  try {
    const { data, error } = await supabaseAdmin.storage
      .from(BUCKET)
      .download(intent.stagingOriginalPath);
    if (error) downloadFailure = error;
    else stagingBlob = data;
  } catch (e) {
    downloadFailure = e;
  }
  perf.mark("downloadMs");

  if (downloadFailure !== null || stagingBlob === null) {
    const normalized = normalizeStorageError(downloadFailure);
    if (normalized.code === "STORAGE_OBJECT_NOT_FOUND") {
      const missing = classifyStagingObjectMissing(
        intent.status === "PREPARED" ? "PREPARED" : "STALE_FINALIZING",
      );
      if (missing.intentTransition === "fail") {
        // stale FINALIZING + missing = 外部干渉。lease 失効・cleanup 無効・
        // session ACTIVE・所有 user を guard した FAILED 遷移（lease は未取得）。
        const failNow = new Date();
        const failed = await prisma.uploadIntent.updateMany({
          where: {
            id: intent.id,
            status: "FINALIZING",
            userId: user.id,
            OR: [{ finalizeLeaseUntil: null }, { finalizeLeaseUntil: { lte: failNow } }],
            AND: [cleanupInactive(failNow)],
            session: {
              status: "ACTIVE",
              userId: user.id,
              OR: [{ cleanupLeaseUntil: null }, { cleanupLeaseUntil: { lte: failNow } }],
            },
          },
          data: {
            status: "FAILED",
            failedAt: failNow,
            lastErrorCode: sanitizeErrorCode(missing.lastErrorCode ?? null),
            lastErrorDetail: sanitizeErrorDetail(missing.lastErrorDetail ?? null),
            finalizeLeaseUntil: null,
            finalizeAttemptToken: null,
          },
        });
        // race で 0 件なら最新契約で応答（勝手に FAILED response を返さない）。
        if (failed.count === 0) return respondByReclassification(intent.id, user.id);
      }
      perf.end({
        path: intent.status === "PREPARED" ? "object_missing" : "fatal_staging_object_lost",
        intentId: intent.id,
        rateLimitEnabled: rl.enabled,
        rateLimitSource: rl.source,
      });
      return rejectionResponse(missing);
    }
    // pre-lease transient: lease は未取得のため lease 操作も DB 遷移もしない。
    perf.end({
      path: "transient_staging_download",
      intentId: intent.id,
      rateLimitEnabled: rl.enabled,
      rateLimitSource: rl.source,
    });
    return rejectionResponse(mapTransientFailure("staging_download"));
  }

  // Blob 参照は即破棄し、以後は単一 Buffer のみを使う（copy 1 回）。
  const originalBuffer = Buffer.from(await stagingBlob.arrayBuffer());
  stagingBlob = null;

  // ---- 6b. image runtime 解決（staging download 成功後・lease CAS 前） ------
  // OBJECT_MISSING / transient の分類はここまでで確定済み。この地点までに
  // DB write 0 / Storage write 0 のため、失敗しても lease を取得せずに返せる。
  const imageRuntime = await loadImageRuntime();
  perf.mark("imageRuntimeMs");
  if (imageRuntime === null) {
    perf.end({
      path: "image_runtime_unavailable",
      intentId: intent.id,
      rateLimitEnabled: rl.enabled,
      rateLimitSource: rl.source,
    });
    return rejectionResponse(IMAGE_RUNTIME_UNAVAILABLE);
  }

  // ---- 7. finalize lease CAS（短 transaction・Storage I/O は入れない） ------
  const attemptToken = randomUUID();
  const leaseNow = new Date();
  let leaseAcquired: boolean;
  try {
    leaseAcquired = await prisma.$transaction(async (tx) => {
      // session guard（row lock 兼用。prepare と同型）。
      const sessionGuard = await tx.uploadSession.updateMany({
        where: {
          id: intent.sessionId,
          workspaceId: intent.workspaceId,
          userId: user.id,
          status: "ACTIVE",
          OR: [{ cleanupLeaseUntil: null }, { cleanupLeaseUntil: { lte: leaseNow } }],
        },
        data: { updatedAt: leaseNow },
      });
      if (sessionGuard.count === 0) return false;

      // intent CAS: PREPARED または stale FINALIZING のみ取得可。
      // deadline は「now === deadline は未超過」の境界に合わせ gte。
      const cas = await tx.uploadIntent.updateMany({
        where: {
          id: intent.id,
          sessionId: intent.sessionId,
          workspaceId: intent.workspaceId,
          userId: user.id,
          intentFinalizeDeadlineAt: { gte: leaseNow },
          OR: [
            { status: "PREPARED" },
            {
              status: "FINALIZING",
              OR: [{ finalizeLeaseUntil: null }, { finalizeLeaseUntil: { lte: leaseNow } }],
            },
          ],
          AND: [cleanupInactive(leaseNow)],
        },
        data: {
          status: "FINALIZING",
          finalizeStartedAt: leaseNow,
          finalizeLeaseUntil: new Date(leaseNow.getTime() + FINALIZE_LEASE_MS),
          finalizeAttemptToken: attemptToken,
          finalizeAttemptCount: { increment: 1 },
          lastErrorCode: null,
          lastErrorDetail: null,
        },
      });
      return cas.count === 1;
    });
  } catch {
    // lease 未確定の DB 失敗。lease 操作はしない（token は誰にも配られていない）。
    perf.end({
      path: "transient_db_transaction",
      intentId: intent.id,
      rateLimitEnabled: rl.enabled,
      rateLimitSource: rl.source,
    });
    return rejectionResponse(mapTransientFailure("db_transaction"));
  }
  perf.mark("leaseMs");

  if (!leaseAcquired) {
    return respondByReclassification(intent.id, user.id);
  }

  // ---- 8. lease 取得後 phase（phase-aware containment） --------------------
  let dbCommitted = false;
  try {
    // transient 失敗の共通 exit（attempt 所有時のみ lease 即時解放）。
    const transientExit = async (stage: TransientStage): Promise<Response> => {
      const rejection = mapTransientFailure(stage);
      if (rejection.releaseLease) {
        await releaseLeaseWithToken(
          intent.id,
          attemptToken,
          rejection.lastErrorCode,
          rejection.lastErrorDetail,
        );
      }
      perf.end({
        path: `transient_${stage}`,
        intentId: intent.id,
        leaseRecovered: recoveredStaleLease,
        rateLimitEnabled: rl.enabled,
        rateLimitSource: rl.source,
      });
      return rejectionResponse(rejection);
    };

    // fatal 遷移の共通 exit（token 条件付き。count=0 = stale → 再分類）。
    const fatalExit = async (rejection: FinalizeRejection, pathLabel: string): Promise<Response> => {
      const applied = await failIntentWithToken(intent.id, attemptToken, rejection, new Date());
      if (!applied) return respondByReclassification(intent.id, user.id);
      perf.end({
        path: pathLabel,
        intentId: intent.id,
        leaseRecovered: recoveredStaleLease,
        rateLimitEnabled: rl.enabled,
        rateLimitSource: rl.source,
      });
      return rejectionResponse(rejection);
    };

    // ---- 8a. measurement（B3a Production entry point のみ） ----------------
    if (!(await ownsAttempt(intent.id, attemptToken, new Date()))) {
      return respondByReclassification(intent.id, user.id);
    }
    const measurementResult = await imageRuntime.measureStagedImage(originalBuffer, {
      declaredSizeBytes: intent.declaredSizeBytes,
      declaredMimeType: intent.declaredMimeType,
      clientFileHash: intent.clientFileHash,
    });
    perf.mark("measurementMs");
    if (!measurementResult.ok) {
      // 全 reason fatal（staging は immutable のため retry しても同じ結果）。
      // staging / canonical / variant object は削除しない（B3c sweep へ委譲）。
      return fatalExit(
        mapMeasurementFailure(measurementResult.reason),
        `fatal_${measurementResult.reason.toLowerCase()}`,
      );
    }
    const measured: MeasuredImage = measurementResult.measured;

    // ---- 8b. canonical path 確定 → PUT より先に DB 保存（所有権ゲート） -----
    const canonicalPath = tempOriginalPath(
      intent.workspaceId,
      intent.sessionId,
      intent.reservedUploadItemId,
      measured.actualExt,
    );
    const pathNow = new Date();
    const pathSaved = await prisma.uploadIntent.updateMany({
      where: {
        id: intent.id,
        status: "FINALIZING",
        finalizeAttemptToken: attemptToken,
        OR: [{ cleanupLeaseUntil: null }, { cleanupLeaseUntil: { lte: pathNow } }],
        AND: [{ OR: [{ canonicalOriginalPath: null }, { canonicalOriginalPath: canonicalPath }] }],
      },
      data: { canonicalOriginalPath: canonicalPath },
    });
    if (pathSaved.count === 0) {
      const latest = await readIntent(intent.id);
      if (
        latest &&
        latest.status === "FINALIZING" &&
        latest.finalizeAttemptToken === attemptToken &&
        latest.canonicalOriginalPath !== null &&
        latest.canonicalOriginalPath !== canonicalPath
      ) {
        // 決定的な measurement と矛盾する既存 path = 外部干渉。
        return fatalExit(CANONICAL_PATH_CONFLICT, "fatal_canonical_path_conflict");
      }
      // token 喪失など。stale worker として Storage write を開始しない。
      return respondByReclassification(intent.id, user.id);
    }

    // ---- 8c. canonical original PUT（このゲート成功後のみ） -----------------
    if (!(await ownsAttempt(intent.id, attemptToken, new Date()))) {
      return respondByReclassification(intent.id, user.id);
    }
    let canonicalPutFailure: unknown = null;
    try {
      const { error } = await supabaseAdmin.storage
        .from(BUCKET)
        .upload(canonicalPath, originalBuffer, {
          contentType: measured.actualMimeType,
          upsert: false,
        });
      canonicalPutFailure = error;
    } catch (e) {
      canonicalPutFailure = e;
    }
    perf.mark("canonicalPutMs");

    if (canonicalPutFailure !== null) {
      const normalized = normalizeStorageError(canonicalPutFailure);
      if (normalized.code !== "STORAGE_OBJECT_ALREADY_EXISTS") {
        return transientExit("canonical_upload");
      }
      // Already-Exists: 既存 object を無条件に信用せず、再 download + 再実測で
      // 検証する（Frozen Plan §9-6 案2）。検証 DL の失敗（missing 含む）は
      // 安全側で transient（無条件再 upload はしない）。
      let verifyFailure: unknown = null;
      let verifyBlob: Blob | null = null;
      try {
        const { data, error } = await supabaseAdmin.storage.from(BUCKET).download(canonicalPath);
        if (error) verifyFailure = error;
        else verifyBlob = data;
      } catch (e) {
        verifyFailure = e;
      }
      if (verifyFailure !== null || verifyBlob === null) {
        return transientExit("canonical_upload");
      }
      const canonicalBytes = Buffer.from(await verifyBlob.arrayBuffer());
      const verification = await imageRuntime.measureStagedImage(canonicalBytes, {
        declaredSizeBytes: measured.actualSizeBytes,
        declaredMimeType: measured.actualMimeType,
        clientFileHash: measured.actualFileHash,
      });
      const decision = decideCanonicalConflict(
        verification.ok
          ? { sizeMatches: true, mimeMatches: true, hashMatches: true }
          : canonicalMatchesFromFailure(verification.reason),
      );
      if (decision.kind !== "idempotent_success") {
        // 上書き・remove・再 upload はいかなる場合も行わない。残骸は B3c 監視。
        return fatalExit(decision, "fatal_canonical_object_conflict");
      }
      // 3 条件一致 = 前 attempt の残骸。冪等成功として続行。
    }

    // ---- 8d. variants（per-variant 独立・nonfatal・両 null 可） --------------
    const variants = await imageRuntime.generateVariants(originalBuffer, intent.variantProfileVersion);
    perf.mark("variantGenerateMs");

    if (!(await ownsAttempt(intent.id, attemptToken, new Date()))) {
      return respondByReclassification(intent.id, user.id);
    }

    // 生成成功 variant のみ PUT。Already-Exists は決定的 profile + 固定 path +
    // upsert:false の構造的不変条件により成功扱い（original と異なり再検証しない
    // — 安全性の根拠が hash commitment である original との非対称。Frozen Plan §9-7）。
    // putVariant は reject しない（Promise.all の一括 reject で片方の成功を失わない）。
    const putVariant = async (outcome: VariantOutcome, path: string): Promise<string | null> => {
      if (!outcome.ok) return null;
      try {
        const { error } = await supabaseAdmin.storage
          .from(BUCKET)
          .upload(path, outcome.buffer, { contentType: "image/webp", upsert: false });
        if (!error) return path;
        return normalizeStorageError(error).code === "STORAGE_OBJECT_ALREADY_EXISTS" ? path : null;
      } catch {
        return null;
      }
    };
    const [thumbnailPath, previewPath] = await Promise.all([
      putVariant(
        variants.thumbnail,
        tempThumbnailPath(intent.workspaceId, intent.sessionId, intent.reservedUploadItemId),
      ),
      putVariant(
        variants.preview,
        tempPreviewPath(intent.workspaceId, intent.sessionId, intent.reservedUploadItemId),
      ),
    ]);
    perf.mark("variantPutMs");

    const variantSummary = summarizeVariantOutcomes({
      profileKnown: variants.profileKnown,
      thumbnailOk: thumbnailPath !== null,
      previewOk: previewPath !== null,
    });

    // ---- 8e. duplicate check（tx 外・legacy multipart と同一条件） -----------
    const existingImage = await prisma.image.findFirst({
      where: {
        workspaceId: intent.workspaceId,
        fileHash: measured.actualFileHash,
        deletedAt: null,
        status: { not: "DELETED" },
      },
      select: { id: true },
    });
    const duplicateStatus = existingImage ? ("DUPLICATE" as const) : ("CLEAN" as const);
    const duplicateImageId = existingImage?.id ?? null;

    // ---- 8f. final transaction（Storage I/O / sharp / signed URL を入れない） -
    if (!(await ownsAttempt(intent.id, attemptToken, new Date()))) {
      return respondByReclassification(intent.id, user.id);
    }
    const txNow = new Date();
    let txOutcome: "committed" | "session_guard" | "membership" | "intent_guard";
    try {
      txOutcome = await prisma.$transaction(async (tx) => {
        const sessionGuard = await tx.uploadSession.updateMany({
          where: {
            id: intent.sessionId,
            workspaceId: intent.workspaceId,
            userId: user.id,
            status: "ACTIVE",
            OR: [{ cleanupLeaseUntil: null }, { cleanupLeaseUntil: { lte: txNow } }],
          },
          data: { updatedAt: txNow },
        });
        if (sessionGuard.count === 0) return "session_guard" as const;

        // membership 剥奪後に UploadItem を作成しない。
        const member = await tx.workspaceMember.findUnique({
          where: { workspaceId_userId: { workspaceId: intent.workspaceId, userId: user.id } },
          select: { workspaceId: true },
        });
        if (!member) return "membership" as const;

        // attemptToken guard が stale writer 排除の本体。lease 有効も確認する。
        const finalized = await tx.uploadIntent.updateMany({
          where: {
            id: intent.id,
            status: "FINALIZING",
            finalizeAttemptToken: attemptToken,
            canonicalOriginalPath: canonicalPath,
            finalizeLeaseUntil: { gt: txNow },
            OR: [{ cleanupLeaseUntil: null }, { cleanupLeaseUntil: { lte: txNow } }],
          },
          data: {
            status: "FINALIZED",
            finalizedAt: txNow,
            uploadItemId: intent.reservedUploadItemId,
            finalizeLeaseUntil: null,
            finalizeAttemptToken: null,
            lastErrorCode: null,
            lastErrorDetail: null,
          },
        });
        if (finalized.count === 0) return "intent_guard" as const;

        // FINALIZED 化と同一 tx 内でのみ create（「item のみ」「FINALIZED のみ」
        // は構造的に不可能。P2002 等は throw → tx 全体 rollback → transient）。
        await tx.uploadItem.create({
          data: {
            id: intent.reservedUploadItemId,
            workspaceId: intent.workspaceId,
            sessionId: intent.sessionId,
            sortOrder: intent.reservedSortOrder,
            originalName: intent.declaredOriginalName,
            originalExt: measured.actualExt,
            mimeType: measured.actualMimeType,
            fileSizeBytes: measured.actualSizeBytes,
            widthPx: measured.widthPx,
            heightPx: measured.heightPx,
            fileHash: measured.actualFileHash,
            tempStoragePath: canonicalPath,
            tempThumbnailPath: thumbnailPath,
            tempPreviewPath: previewPath,
            uploadStatus: "READY",
            promptStatus: "EMPTY",
            duplicateStatus,
            duplicateImageId,
            commitStatus: "PENDING",
            // F1: reservedImageId / asset*Path は設定しない（schema default null。
            // commit は reservedImageId falsy を条件に asset path を生成するため）。
          },
        });
        return "committed" as const;
      });
    } catch {
      return transientExit("db_transaction");
    }
    perf.mark("dbMs");

    if (txOutcome === "membership") {
      await releaseLeaseWithToken(intent.id, attemptToken, "MEMBERSHIP_LOST", "Workspace membership was revoked during finalize");
      return Errors.forbidden();
    }
    if (txOutcome !== "committed") {
      // session guard / intent guard の失敗。自分の lease は解放してから
      // 最新契約で応答する（token 条件付きのため他 attempt には作用しない）。
      await releaseLeaseWithToken(intent.id, attemptToken);
      return respondByReclassification(intent.id, user.id);
    }
    dbCommitted = true;

    // ---- 8g. response（signed URL 失敗は nonfatal） -------------------------
    const response = await buildItemResponse(intent.reservedUploadItemId, intent.workspaceId, user.id, 201);
    perf.mark("signedUrlMs");
    perf.end({
      path: "created",
      intentId: intent.id,
      actualSizeBytes: measured.actualSizeBytes,
      pixelCount: measured.pixelCount,
      duplicateStatus,
      thumbnailOk: thumbnailPath !== null,
      previewOk: previewPath !== null,
      variantWarnings: variantSummary.warnings.length,
      leaseRecovered: recoveredStaleLease,
      reservedSortOrder: intent.reservedSortOrder,
      rateLimitEnabled: rl.enabled,
      rateLimitSource: rl.source,
    });
    return response;
  } catch {
    // 想定外例外の封じ込め。raw error は response / DB / console へ出さない。
    // DB commit 済みなら lease は tx が清算済み — 解放処理を行わない
    // （client の再送は FINALIZED replay 200 へ収束する）。
    if (!dbCommitted) {
      const rejection = mapTransientFailure("storage_unknown");
      await releaseLeaseWithToken(intent.id, attemptToken, rejection.lastErrorCode, rejection.lastErrorDetail);
      return rejectionResponse(rejection);
    }
    return rejectionResponse(mapTransientFailure("storage_unknown"));
  }
}
