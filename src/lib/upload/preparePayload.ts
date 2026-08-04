// Phase 10-43-B2: POST /api/uploads/items/prepare の request payload 検証。
//
// pure（Prisma / Supabase / server-only を import しない）ので unit test で
// 境界をすべて固定できる。route 側は「検証済みの値」だけを受け取る。
//
// 重要な契約:
// - 許可する 6 キー以外を含む body は拒否する（exact-key validation）
// - workspaceId / userId / path / bucket / intentId / sortOrder / 期限 /
//   signed URL / upsert / canonical path / variant version は client から
//   受け取らない（キー自体が存在したら「追加キー」として拒否される）
// - error message には入力値を一切含めない（log/レスポンス双方の漏洩防止）

import { MAX_ORIGINAL_BYTES, MAX_ORIGINAL_MB } from "./uploadLimits";

export const PREPARE_ALLOWED_KEYS = [
  "sessionId",
  "clientUploadId",
  "originalName",
  "declaredSizeBytes",
  "declaredMimeType",
  "clientFileHash",
] as const;

export type PrepareAllowedKey = (typeof PREPARE_ALLOWED_KEYS)[number];

// finalize が magic bytes で実測するまで信頼しないが、prepare 段では
// 明らかに扱えない形式を早期に弾く（bucket 側の allowed MIME と一致）。
export const PREPARE_ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type PrepareAllowedMimeType = (typeof PREPARE_ALLOWED_MIME_TYPES)[number];

export const ORIGINAL_NAME_MAX_LENGTH = 255;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SHA256_LOWER_HEX_RE = /^[0-9a-f]{64}$/;

export type PreparePayload = {
  sessionId: string;
  clientUploadId: string;
  originalName: string;
  declaredSizeBytes: number;
  declaredMimeType: PrepareAllowedMimeType;
  clientFileHash: string;
};

// kind は route 側の HTTP status / error code へのマッピングに使う。
// - validation            → 400 VALIDATION_ERROR
// - unsupported_media_type → 415 UNSUPPORTED_MEDIA_TYPE
// - payload_too_large      → 413 PAYLOAD_TOO_LARGE
export type PreparePayloadError = {
  kind: "validation" | "unsupported_media_type" | "payload_too_large";
  message: string;
};

export type PreparePayloadResult =
  | { ok: true; payload: PreparePayload }
  | { ok: false; error: PreparePayloadError };

const invalid = (message: string): PreparePayloadResult => ({
  ok: false,
  error: { kind: "validation", message },
});

export function parsePreparePayload(body: unknown): PreparePayloadResult {
  // ---- body 全体 --------------------------------------------------------
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return invalid("Request body must be a JSON object");
  }

  const keys = Object.keys(body as Record<string, unknown>);
  const allowed = new Set<string>(PREPARE_ALLOWED_KEYS);
  // 追加キーは拒否（workspaceId / path / token 期限などを client から受け取らない）
  const unexpected = keys.filter((k) => !allowed.has(k));
  if (unexpected.length > 0) {
    // キー名自体は client 由来だが、値は含めない。キー名を返さないと
    // 呼び出し側が原因を特定できないため、件数のみ示す。
    return invalid(`Request body contains ${unexpected.length} unsupported field(s)`);
  }

  const raw = body as Record<string, unknown>;
  const missing = PREPARE_ALLOWED_KEYS.filter((k) => !(k in raw));
  if (missing.length > 0) {
    return invalid(`Missing required field(s): ${missing.join(", ")}`);
  }

  // ---- sessionId --------------------------------------------------------
  if (typeof raw.sessionId !== "string") return invalid("sessionId must be a string");
  const sessionId = raw.sessionId.trim();
  if (sessionId.length === 0) return invalid("sessionId must not be empty");

  // ---- clientUploadId ---------------------------------------------------
  if (typeof raw.clientUploadId !== "string") return invalid("clientUploadId must be a string");
  const clientUploadId = raw.clientUploadId.trim();
  if (!UUID_RE.test(clientUploadId)) return invalid("clientUploadId must be a UUID");

  // ---- originalName -----------------------------------------------------
  // fingerprint には「受信した文字列そのまま」を使うため trim した値へ
  // 置き換えない（trim 後が空かどうかの判定だけに使う）。
  if (typeof raw.originalName !== "string") return invalid("originalName must be a string");
  const originalName = raw.originalName;
  if (originalName.length < 1 || originalName.length > ORIGINAL_NAME_MAX_LENGTH) {
    return invalid(`originalName must be 1-${ORIGINAL_NAME_MAX_LENGTH} characters`);
  }
  if (originalName.trim().length === 0) return invalid("originalName must not be blank");
  if (originalName.includes("\u0000")) return invalid("originalName must not contain NUL");

  // ---- declaredMimeType -------------------------------------------------
  // size より先に判定する（415 は形式、413 は大きさ。形式不正なら大きさは無意味）。
  if (typeof raw.declaredMimeType !== "string") return invalid("declaredMimeType must be a string");
  const declaredMimeType = raw.declaredMimeType;
  if (!(PREPARE_ALLOWED_MIME_TYPES as readonly string[]).includes(declaredMimeType)) {
    return {
      ok: false,
      error: {
        kind: "unsupported_media_type",
        message: `declaredMimeType must be one of: ${PREPARE_ALLOWED_MIME_TYPES.join(", ")}`,
      },
    };
  }

  // ---- declaredSizeBytes ------------------------------------------------
  if (typeof raw.declaredSizeBytes !== "number" || !Number.isSafeInteger(raw.declaredSizeBytes)) {
    return invalid("declaredSizeBytes must be a safe integer");
  }
  const declaredSizeBytes = raw.declaredSizeBytes;
  if (declaredSizeBytes < 1) return invalid("declaredSizeBytes must be >= 1");
  if (declaredSizeBytes > MAX_ORIGINAL_BYTES) {
    return {
      ok: false,
      error: {
        kind: "payload_too_large",
        message: `declaredSizeBytes exceeds ${MAX_ORIGINAL_MB}MB limit`,
      },
    };
  }

  // ---- clientFileHash ---------------------------------------------------
  // 小文字 hex 固定。uppercase を自動変換せず拒否する（fingerprint と
  // finalize 側の照合を 1 つの正規形へ固定するため）。
  if (typeof raw.clientFileHash !== "string") return invalid("clientFileHash must be a string");
  const clientFileHash = raw.clientFileHash;
  if (!SHA256_LOWER_HEX_RE.test(clientFileHash)) {
    return invalid("clientFileHash must be a lowercase hex SHA-256 (64 chars)");
  }

  return {
    ok: true,
    payload: {
      sessionId,
      clientUploadId,
      originalName,
      declaredSizeBytes,
      declaredMimeType: declaredMimeType as PrepareAllowedMimeType,
      clientFileHash,
    },
  };
}

// Content-Type が JSON 系かどうか。charset 等の parameter は許容する。
export function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return mime === "application/json" || mime.endsWith("+json");
}
