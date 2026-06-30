import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { Errors } from "@/lib/apiResponse";
import {
  resolveSignedUrls,
  hasExtraKeys,
  isValidItemType,
  isValidVariant,
  type BatchRequest,
  type SignedUrlFailure,
} from "@/lib/signedUrl";
import { NextResponse } from "next/server";

const MAX_BATCH = 100;

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Errors.validation("Invalid JSON");
  }

  const { requests } = (body ?? {}) as Record<string, unknown>;

  if (!Array.isArray(requests)) {
    return Errors.validation("requests must be an array");
  }

  if (requests.length > MAX_BATCH) {
    return Errors.validation(`Max ${MAX_BATCH} items per batch`);
  }

  const validRequests: BatchRequest[] = [];
  const invalidFailed: SignedUrlFailure[] = [];

  for (let i = 0; i < requests.length; i++) {
    const r = requests[i];

    if (typeof r !== "object" || r === null) {
      invalidFailed.push({ index: i, type: "", id: "", variant: "", reason: "INVALID_REQUEST" });
      continue;
    }

    const obj = r as Record<string, unknown>;

    // 余計なキーがあれば INVALID_REQUEST
    if (hasExtraKeys(obj)) {
      invalidFailed.push({
        index: i,
        type: String(obj.type ?? ""),
        id: String(obj.id ?? ""),
        variant: String(obj.variant ?? ""),
        reason: "INVALID_REQUEST",
      });
      continue;
    }

    if (!isValidItemType(obj.type) || typeof obj.id !== "string" || !obj.id || !isValidVariant(obj.variant)) {
      invalidFailed.push({
        index: i,
        type: String(obj.type ?? ""),
        id: String(obj.id ?? ""),
        variant: String(obj.variant ?? ""),
        reason: "INVALID_REQUEST",
      });
      continue;
    }

    validRequests.push({ index: i, type: obj.type, id: obj.id, variant: obj.variant });
  }

  const { results, failed } = await resolveSignedUrls(validRequests, user.id);

  // 元の index 順にソートして返す
  const allFailed = [...invalidFailed, ...failed].sort((a, b) => a.index - b.index);
  const allResults = results.sort((a, b) => a.index - b.index);

  return NextResponse.json({ results: allResults, failed: allFailed });
}
