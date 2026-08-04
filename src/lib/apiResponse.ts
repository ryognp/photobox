import "server-only";

import { NextResponse } from "next/server";

export type ErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "VALIDATION_ERROR"
  | "CONFLICT"
  | "NOT_FOUND"
  | "INTERNAL_ERROR"
  | "NO_PATH"
  | "FILE_HASH_MISMATCH"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  // Phase 10-43-B2: POST /api/uploads/items/prepare
  | "SESSION_CLEANUP_IN_PROGRESS"
  | "INTENT_CLEANUP_IN_PROGRESS"
  | "IDEMPOTENCY_CONFLICT"
  | "TOKEN_ISSUE_DEADLINE_EXCEEDED"
  | "INTENT_EXPIRED"
  | "FINALIZE_IN_PROGRESS"
  | "INTENT_NOT_REUSABLE"
  | "SIGNED_UPLOAD_URL_ISSUE_FAILED"
  // Phase 10-43-B3a: finalize 実測検証（route 接続は B3b。pixel 上限超過用）
  | "IMAGE_TOO_LARGE_PIXELS";

export function ok<T>(data: T, status = 200) {
  return NextResponse.json({ data }, { status });
}

/**
 * Same envelope as ok(), but with `Cache-Control: no-store`.
 * For responses that carry short-lived credentials (e.g. the signed upload
 * token from POST /api/uploads/items/prepare) — these must never be cached by
 * the browser or any intermediary.
 */
export function okNoStore<T>(data: T, status = 200) {
  return NextResponse.json({ data }, { status, headers: { "Cache-Control": "no-store" } });
}

export function err(code: ErrorCode, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export const Errors = {
  unauthorized: () => err("UNAUTHORIZED", "Authentication required", 401),
  forbidden: () => err("FORBIDDEN", "Access denied", 403),
  validation: (message: string) => err("VALIDATION_ERROR", message, 400),
  conflict: (message: string) => err("CONFLICT", message, 409),
  notFound: (message: string) => err("NOT_FOUND", message, 404),
  internal: () => err("INTERNAL_ERROR", "Internal server error", 500),
  rateLimited: (headers?: HeadersInit) => {
    const h = new Headers(headers);
    h.set("Cache-Control", "no-store");
    return NextResponse.json(
      { error: { code: "RATE_LIMITED", message: "Too many requests. Please try again later." } },
      { status: 429, headers: h },
    );
  },
};
