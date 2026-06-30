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
  | "PAYLOAD_TOO_LARGE";

export function ok<T>(data: T, status = 200) {
  return NextResponse.json({ data }, { status });
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
};
