import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { err, ok, Errors, type ErrorCode } from "@/lib/apiResponse";
import {
  resolveSignedUrl,
  hasExtraKeys,
  isValidItemType,
  isValidVariant,
} from "@/lib/signedUrl";

const REASON_TO_RESPONSE: Record<string, { code: ErrorCode; message: string; status: number }> = {
  NOT_FOUND:      { code: "NOT_FOUND",        message: "Resource not found",          status: 404 },
  FORBIDDEN:      { code: "FORBIDDEN",         message: "Access denied",               status: 403 },
  NO_PATH:        { code: "NO_PATH",           message: "No storage path available",   status: 400 },
  INVALID_REQUEST:{ code: "VALIDATION_ERROR",  message: "Invalid request",             status: 400 },
};

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Errors.validation("Invalid JSON");
  }

  if (typeof body !== "object" || body === null) {
    return Errors.validation("Request body must be an object");
  }

  const obj = body as Record<string, unknown>;

  // 余計なキー（path / bucket / storagePath 等）を明示的に拒否
  if (hasExtraKeys(obj)) {
    return Errors.validation("Unexpected keys in request. Only type, id, variant are allowed.");
  }

  const { type, id, variant } = obj;

  if (!isValidItemType(type) || typeof id !== "string" || !id || !isValidVariant(variant)) {
    return Errors.validation("type, id, variant are required and must be valid values");
  }

  const result = await resolveSignedUrl(type, id, variant, user.id, 0);

  if ("reason" in result) {
    const r = REASON_TO_RESPONSE[result.reason] ?? { code: "INTERNAL_ERROR" as ErrorCode, message: "Unknown error", status: 500 };
    return err(r.code, r.message, r.status);
  }

  // index は単体 API では不要なので除外
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { index, ...rest } = result;
  return ok(rest);
}
