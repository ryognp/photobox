import "server-only";

export const dynamic = "force-dynamic";
// Uses node:crypto (createHash / randomUUID) — Node.js runtime only.
export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import cuid from "cuid";
import { Prisma } from "@/generated/prisma/client";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { err, okNoStore, Errors } from "@/lib/apiResponse";
import { createPerfLog } from "@/lib/perfLog";
import { checkUserRateLimit, rateLimitHeaders } from "@/lib/rateLimit";
import { authorizeSession } from "@/lib/uploadSession";
import { readDirectUploadEnabledFlag } from "@/lib/upload/directUploadFeature";
import { intentStagingOriginalPath } from "@/lib/upload/storagePaths";
import { reserveSortOrder } from "@/lib/upload/sortOrderReservation";
import { isJsonContentType, parsePreparePayload, type PreparePayload } from "@/lib/upload/preparePayload";
import {
  canonicalFingerprintInput,
  computeIntentDeadlines,
  isLeaseActive,
  isPastFinalizeDeadline,
  isSameFingerprint,
  sanitizeErrorCode,
  sanitizeErrorDetail,
  CURRENT_VARIANT_PROFILE_VERSION,
  SIGNED_UPLOAD_TOKEN_TTL_MS,
  type UploadIntentStatusValue,
} from "@/lib/upload/uploadIntentCore";

const BUCKET = "photobox-private";

// intent の read/write で使う最小 select。token / hash は response へ出さないが、
// 状態判定に必要なものだけを取る。
const INTENT_SELECT = {
  id: true,
  workspaceId: true,
  sessionId: true,
  userId: true,
  status: true,
  requestFingerprint: true,
  reservedUploadItemId: true,
  reservedSortOrder: true,
  stagingOriginalPath: true,
  tokenIssueDeadlineAt: true,
  intentFinalizeDeadlineAt: true,
  cleanupLeaseUntil: true,
  uploadItemId: true,
} as const;

type IntentRow = {
  id: string;
  workspaceId: string;
  sessionId: string;
  userId: string;
  status: UploadIntentStatusValue;
  requestFingerprint: string;
  reservedUploadItemId: string;
  reservedSortOrder: number;
  stagingOriginalPath: string;
  tokenIssueDeadlineAt: Date;
  intentFinalizeDeadlineAt: Date;
  cleanupLeaseUntil: Date | null;
  uploadItemId: string | null;
};

function fingerprintOf(payload: PreparePayload): string {
  // B1 の canonical helper を唯一の正本として使う（route 内で別実装しない）。
  return createHash("sha256")
    .update(
      canonicalFingerprintInput({
        sessionId: payload.sessionId,
        clientUploadId: payload.clientUploadId,
        originalName: payload.originalName,
        declaredSizeBytes: payload.declaredSizeBytes,
        declaredMimeType: payload.declaredMimeType,
        clientFileHash: payload.clientFileHash,
      }),
    )
    .digest("hex");
}

/** Prisma の unique 制約違反だけを安全に判定する（provider message 文字列に依存しない）。 */
function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

type SessionRejection = { status: number; body: ReturnType<typeof err> };

/**
 * session が prepare を受け付けられるかを read-only で再分類する。
 * 条件付き UPDATE が 0 件だったときに、一般 DB error へ変換せず理由を特定するために使う。
 */
async function classifySessionRejection(sessionId: string, userId: string, now: Date): Promise<SessionRejection> {
  const session = await prisma.uploadSession.findUnique({
    where: { id: sessionId },
    select: { userId: true, status: true, cleanupLeaseUntil: true },
  });
  if (!session) return { status: 404, body: Errors.notFound("Session not found") };
  if (session.userId !== userId) return { status: 403, body: Errors.forbidden() };
  if (isLeaseActive(session.cleanupLeaseUntil, now)) {
    return {
      status: 409,
      body: err("SESSION_CLEANUP_IN_PROGRESS", "This session is being cleaned up. Please retry shortly.", 409),
    };
  }
  if (session.status !== "ACTIVE") {
    return {
      status: 400,
      body: Errors.validation(
        `Session status is '${session.status}'. Only ACTIVE sessions accept uploads.`,
      ),
    };
  }
  // ここに来るのは通常のレース（直後に再び ACTIVE になった等）。安全側で 409。
  return {
    status: 409,
    body: err("CONFLICT", "Session state changed during preparation. Please retry.", 409),
  };
}

export async function POST(request: NextRequest) {
  const perf = createPerfLog("uploads.prepare");

  // ---- 0. direct upload gate（未接続機能の外部公開防止。auth より前） -----
  // 無効時は auth 状態に関わらず一律 404 にし、有効化されているかどうかを
  // 認証結果の違いから推測できないようにする。
  if (!readDirectUploadEnabledFlag()) {
    return err("NOT_FOUND", "Not found", 404);
  }

  // ---- 1. 認証 -----------------------------------------------------------
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();
  perf.mark("authMs");

  // ---- 2. rate limit（JSON parse より前） --------------------------------
  const rl = await checkUserRateLimit({ preset: "uploadPrepare", userId: user.id });
  perf.mark("rateLimitMs");
  if (!rl.allowed) return Errors.rateLimited(rateLimitHeaders(rl));

  // ---- 3. JSON parse ----------------------------------------------------
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return Errors.validation("Content-Type must be application/json");
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Errors.validation("Invalid JSON body");
  }

  // ---- 4. exact-key validation ------------------------------------------
  const parsed = parsePreparePayload(body);
  if (!parsed.ok) {
    const { kind, message } = parsed.error;
    if (kind === "unsupported_media_type") return err("UNSUPPORTED_MEDIA_TYPE", message, 415);
    if (kind === "payload_too_large") return err("PAYLOAD_TOO_LARGE", message, 413);
    return Errors.validation(message);
  }
  const payload = parsed.payload;
  perf.mark("validateMs");

  // ---- 5. session 認可 --------------------------------------------------
  const auth = await authorizeSession(payload.sessionId, user.id);
  if (!auth.ok) {
    return auth.reason === "NOT_FOUND" ? Errors.notFound("Session not found") : Errors.forbidden();
  }
  const { workspaceId } = auth.session;

  // 認可 session の付随状態（cleanup lease）を確認する。
  const sessionState = await prisma.uploadSession.findUnique({
    where: { id: payload.sessionId },
    select: { status: true, cleanupLeaseUntil: true },
  });
  if (!sessionState) return Errors.notFound("Session not found");

  const now = new Date();
  if (isLeaseActive(sessionState.cleanupLeaseUntil, now)) {
    return err("SESSION_CLEANUP_IN_PROGRESS", "This session is being cleaned up. Please retry shortly.", 409);
  }
  if (sessionState.status !== "ACTIVE") {
    return Errors.validation(
      `Session status is '${sessionState.status}'. Only ACTIVE sessions accept uploads.`,
    );
  }
  perf.mark("sessionMs");

  // ---- 6. fingerprint + 既存 intent --------------------------------------
  const requestFingerprint = fingerprintOf(payload);

  const existing = (await prisma.uploadIntent.findUnique({
    where: { sessionId_clientUploadId: { sessionId: payload.sessionId, clientUploadId: payload.clientUploadId } },
    select: INTENT_SELECT,
  })) as IntentRow | null;

  if (existing) {
    return handleExistingIntent({ intent: existing, requestFingerprint, userId: user.id, perf, rl });
  }

  // ---- 7. 新規 intent（sortOrder 予約と同一 transaction） -----------------
  const intentId = cuid();
  const reservedUploadItemId = cuid();
  const stagingOriginalPath = intentStagingOriginalPath(workspaceId, payload.sessionId, intentId);
  const createdAt = new Date();
  const deadlines = computeIntentDeadlines(createdAt);

  let created: IntentRow;
  try {
    const result = await prisma.$transaction(async (tx) => {
      // session を条件付きで guard し row lock を取る（業務状態は変えない）。
      const guarded = await tx.uploadSession.updateMany({
        where: {
          id: payload.sessionId,
          userId: user.id,
          status: "ACTIVE",
          OR: [{ cleanupLeaseUntil: null }, { cleanupLeaseUntil: { lte: createdAt } }],
        },
        data: { updatedAt: createdAt },
      });
      if (guarded.count === 0) return { kind: "session_guard_failed" as const };

      const reservation = await reserveSortOrder(tx, payload.sessionId);
      if (!reservation.ok) return { kind: "session_guard_failed" as const };

      const intent = (await tx.uploadIntent.create({
        data: {
          id: intentId,
          workspaceId,
          sessionId: payload.sessionId,
          userId: user.id,
          reservedUploadItemId,
          clientUploadId: payload.clientUploadId,
          requestFingerprint,
          declaredOriginalName: payload.originalName,
          declaredMimeType: payload.declaredMimeType,
          declaredSizeBytes: payload.declaredSizeBytes,
          clientFileHash: payload.clientFileHash,
          stagingOriginalPath,
          reservedSortOrder: reservation.sortOrder,
          variantProfileVersion: CURRENT_VARIANT_PROFILE_VERSION,
          tokenIssueDeadlineAt: deadlines.tokenIssueDeadlineAt,
          intentFinalizeDeadlineAt: deadlines.intentFinalizeDeadlineAt,
          storageCleanupNotBefore: deadlines.storageCleanupNotBefore,
          createdAt,
          // status / canonicalOriginalPath / signedUpload* / uploadItemId は schema default（PREPARED / null）
        },
        select: INTENT_SELECT,
      })) as IntentRow;

      return { kind: "created" as const, intent };
    });

    if (result.kind === "session_guard_failed") {
      const rejection = await classifySessionRejection(payload.sessionId, user.id, new Date());
      return rejection.body;
    }
    created = result.intent;
  } catch (e) {
    // 同一 (sessionId, clientUploadId) の並行 prepare。loser 側は transaction ごと
    // rollback されている（counter increment も戻る）ので、勝者の intent を読み直して
    // 冪等処理へ合流する。unique violation 以外は 500 経路へ伝播させる。
    if (!isUniqueViolation(e)) throw e;

    const winner = (await prisma.uploadIntent.findUnique({
      where: { sessionId_clientUploadId: { sessionId: payload.sessionId, clientUploadId: payload.clientUploadId } },
      select: INTENT_SELECT,
    })) as IntentRow | null;
    if (!winner) throw e; // unique violation なのに読めない = 想定外
    return handleExistingIntent({ intent: winner, requestFingerprint, userId: user.id, perf, rl });
  }
  perf.mark("intentCreateMs");

  return issueTokenAndRespond({ intent: created, isNew: true, perf, rl });
}

// ---------------------------------------------------------------------------
// 既存 intent の状態別契約
// ---------------------------------------------------------------------------

async function handleExistingIntent(args: {
  intent: IntentRow;
  requestFingerprint: string;
  userId: string;
  perf: ReturnType<typeof createPerfLog>;
  rl: Awaited<ReturnType<typeof checkUserRateLimit>>;
}) {
  const { intent, requestFingerprint, perf, rl } = args;

  // fingerprint 不一致は status に関係なく最優先で 409（既存 intent 情報は返さない）。
  if (!isSameFingerprint(intent.requestFingerprint, requestFingerprint)) {
    return err(
      "IDEMPOTENCY_CONFLICT",
      "clientUploadId was already used with a different request payload.",
      409,
    );
  }

  const now = new Date();

  switch (intent.status) {
    case "FINALIZED":
      perf.end({ path: "already_finalized", rateLimitEnabled: rl.enabled, rateLimitSource: rl.source });
      return okNoStore({
        intentId: intent.id,
        reservedUploadItemId: intent.reservedUploadItemId,
        reservedSortOrder: intent.reservedSortOrder,
        alreadyFinalized: true,
        uploadItemId: intent.uploadItemId,
      });

    case "FINALIZING":
      return err("FINALIZE_IN_PROGRESS", "This upload is being finalized. Please retry shortly.", 409);

    case "FAILED":
    case "EXPIRED":
    case "CANCELLED":
      return err(
        "INTENT_NOT_REUSABLE",
        "This upload intent can no longer be used. Start a new upload.",
        400,
      );

    case "PREPARED":
      break;
  }

  // ---- PREPARED: 再確認 --------------------------------------------------
  if (isLeaseActive(intent.cleanupLeaseUntil, now)) {
    return err("INTENT_CLEANUP_IN_PROGRESS", "This upload intent is being cleaned up.", 409);
  }

  if (isPastFinalizeDeadline({ now, intentFinalizeDeadlineAt: intent.intentFinalizeDeadlineAt })) {
    // PREPARED かつ cleanup lease 無効であることを条件に atomic に EXPIRED へ。
    const expired = await prisma.uploadIntent.updateMany({
      where: {
        id: intent.id,
        status: "PREPARED",
        OR: [{ cleanupLeaseUntil: null }, { cleanupLeaseUntil: { lte: now } }],
      },
      data: { status: "EXPIRED" },
    });
    if (expired.count === 0) {
      // 競合で status が変わっていた。最新状態の契約へ従う。
      const latest = (await prisma.uploadIntent.findUnique({
        where: { id: intent.id },
        select: INTENT_SELECT,
      })) as IntentRow | null;
      if (latest && latest.status !== "PREPARED") {
        return handleExistingIntent({ ...args, intent: latest });
      }
    }
    return err("INTENT_EXPIRED", "This upload intent has expired. Start a new upload.", 400);
  }

  if (now.getTime() >= intent.tokenIssueDeadlineAt.getTime()) {
    return err(
      "TOKEN_ISSUE_DEADLINE_EXCEEDED",
      "A new signed upload token can no longer be issued for this intent.",
      409,
    );
  }

  // token 再発行（同じ intent / reservedUploadItemId / sortOrder / staging path）
  return issueTokenAndRespond({ intent, isNew: false, perf, rl });
}

// ---------------------------------------------------------------------------
// signed upload token 発行（DB transaction 外）
// ---------------------------------------------------------------------------

async function issueTokenAndRespond(args: {
  intent: IntentRow;
  isNew: boolean;
  perf: ReturnType<typeof createPerfLog>;
  rl: Awaited<ReturnType<typeof checkUserRateLimit>>;
}) {
  const { intent, isNew, perf, rl } = args;

  const { data, error } = await supabaseAdmin.storage
    .from(BUCKET)
    .createSignedUploadUrl(intent.stagingOriginalPath, { upsert: false });
  perf.mark("signedUploadUrlMs");

  const tokenOk =
    !error && data !== null && typeof data.token === "string" && data.token.length > 0 && data.path === intent.stagingOriginalPath;

  if (!tokenOk) {
    // intent は削除せず PREPARED のまま。同じ clientUploadId で再試行可能。
    // provider message は保存しない（固定文のみ）。
    await prisma.uploadIntent
      .updateMany({
        where: { id: intent.id, status: "PREPARED" },
        data: {
          lastErrorCode: sanitizeErrorCode("SIGNED_UPLOAD_URL_ISSUE_FAILED"),
          lastErrorDetail: sanitizeErrorDetail("Signed upload token issuance failed"),
        },
      })
      .catch(() => undefined);
    perf.end({ path: "token_issue_failed", rateLimitEnabled: rl.enabled, rateLimitSource: rl.source });
    return err("SIGNED_UPLOAD_URL_ISSUE_FAILED", "Failed to issue a signed upload token. Please retry.", 500);
  }

  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + SIGNED_UPLOAD_TOKEN_TTL_MS);

  // token を返す前に、intent と session の条件を再確認したうえでのみ記録する。
  const persisted = await prisma.uploadIntent.updateMany({
    where: {
      id: intent.id,
      status: "PREPARED",
      OR: [{ cleanupLeaseUntil: null }, { cleanupLeaseUntil: { lte: issuedAt } }],
      tokenIssueDeadlineAt: { gt: issuedAt },
      intentFinalizeDeadlineAt: { gt: issuedAt },
      session: {
        status: "ACTIVE",
        OR: [{ cleanupLeaseUntil: null }, { cleanupLeaseUntil: { lte: issuedAt } }],
      },
    },
    data: {
      signedUploadIssuedAt: issuedAt,
      signedUploadExpiresAt: expiresAt,
      lastErrorCode: null,
      lastErrorDetail: null,
    },
  });

  if (persisted.count === 0) {
    // 発行済み token は client へ渡さない（孤立 token として外部利用されない）。
    const latest = (await prisma.uploadIntent.findUnique({
      where: { id: intent.id },
      select: INTENT_SELECT,
    })) as IntentRow | null;
    perf.end({ path: "token_persist_conflict", rateLimitEnabled: rl.enabled, rateLimitSource: rl.source });

    if (!latest) return Errors.notFound("Upload intent not found");
    if (latest.status === "FINALIZING") {
      return err("FINALIZE_IN_PROGRESS", "This upload is being finalized. Please retry shortly.", 409);
    }
    if (latest.status === "FINALIZED") {
      return okNoStore({
        intentId: latest.id,
        reservedUploadItemId: latest.reservedUploadItemId,
        reservedSortOrder: latest.reservedSortOrder,
        alreadyFinalized: true,
        uploadItemId: latest.uploadItemId,
      });
    }
    if (latest.status !== "PREPARED") {
      return err("INTENT_NOT_REUSABLE", "This upload intent can no longer be used. Start a new upload.", 400);
    }
    if (isLeaseActive(latest.cleanupLeaseUntil, new Date())) {
      return err("INTENT_CLEANUP_IN_PROGRESS", "This upload intent is being cleaned up.", 409);
    }
    return err("CONFLICT", "Upload preparation state changed. Please retry.", 409);
  }

  perf.end({
    path: isNew ? "created" : "token_reissued",
    reservedSortOrder: intent.reservedSortOrder,
    rateLimitEnabled: rl.enabled,
    rateLimitSource: rl.source,
  });

  return okNoStore(
    {
      intentId: intent.id,
      reservedUploadItemId: intent.reservedUploadItemId,
      reservedSortOrder: intent.reservedSortOrder,
      alreadyFinalized: false,
      upload: {
        bucket: BUCKET,
        path: intent.stagingOriginalPath,
        token: data.token,
        expiresAt: expiresAt.toISOString(),
      },
    },
    isNew ? 201 : 200,
  );
}
