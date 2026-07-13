import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, Errors } from "@/lib/apiResponse";
import { authorizeSession, fetchSessionWithItems, SESSION_SELECT } from "@/lib/uploadSession";
import { SessionStatus } from "@/generated/prisma/enums";

// PATCH で設定可能な status（COMMITTED は commit API のみが設定できる）
const PATCHABLE_STATUSES = new Set(["ACTIVE", "PREVIEWING", "ABANDONED"]);

// ---- GET ----------------------------------------------------------------
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();

  const { id } = await params;
  const auth = await authorizeSession(id, user.id);
  if (!auth.ok) {
    return auth.reason === "NOT_FOUND" ? Errors.notFound("Session not found") : Errors.forbidden();
  }

  const data = await fetchSessionWithItems(id, user.id);
  if (!data) return Errors.internal();
  return ok(data);
}

// ---- PATCH --------------------------------------------------------------
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();

  const { id } = await params;
  const auth = await authorizeSession(id, user.id);
  if (!auth.ok) {
    return auth.reason === "NOT_FOUND" ? Errors.notFound("Session not found") : Errors.forbidden();
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Errors.validation("Invalid JSON");
  }

  const updates: { title?: string | null; status?: SessionStatus } = {};

  // title
  if ("title" in body) {
    const rawTitle = body.title;
    if (typeof rawTitle === "string") {
      updates.title = rawTitle.trim() || null;
    } else if (rawTitle === null) {
      updates.title = null;
    } else {
      return Errors.validation("title must be a string or null");
    }
  }

  // status
  if ("status" in body) {
    const rawStatus = body.status;
    if (typeof rawStatus !== "string" || !PATCHABLE_STATUSES.has(rawStatus)) {
      const allowed = [...PATCHABLE_STATUSES].join(", ");
      return Errors.validation(`status must be one of: ${allowed}. COMMITTED can only be set by the commit API.`);
    }
    updates.status = rawStatus as SessionStatus;
  }

  if (Object.keys(updates).length === 0) {
    return Errors.validation("No updatable fields provided");
  }

  await prisma.uploadSession.update({
    where: { id },
    data: updates,
  });

  const data = await fetchSessionWithItems(id, user.id);
  if (!data) return Errors.internal();
  return ok(data);
}

// ---- DELETE -------------------------------------------------------------
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();

  const { id } = await params;
  const auth = await authorizeSession(id, user.id);
  if (!auth.ok) {
    return auth.reason === "NOT_FOUND" ? Errors.notFound("Session not found") : Errors.forbidden();
  }

  // Phase 10-19A review fix: COMMITTED session / COMMITTED itemを含むsessionは
  // キャンセル(ABANDONED化)不可。ACTIVE/PREVIEWINGの未commit sessionのみ許可。
  if (auth.session.status === "COMMITTED") {
    return Errors.validation("This session is already committed and cannot be cancelled.");
  }

  const committedItemCount = await prisma.uploadItem.count({
    where: { sessionId: id, commitStatus: "COMMITTED" },
  });
  if (committedItemCount > 0) {
    return Errors.validation("This session has committed items and cannot be cancelled.");
  }

  // MVP: 物理削除しない。status = ABANDONED に更新する。
  // Storage 削除・upload_items 削除は将来の cleanup job で行う。
  // 安全弁: COMMITTED sessionは絶対にABANDONED化しない(上のチェックをすり抜けても
  // updateManyのwhereで弾かれ、更新0件になる)。
  const updated = await prisma.uploadSession.updateMany({
    where: { id, status: { in: ["ACTIVE", "PREVIEWING", "ABANDONED"] } },
    data: { status: "ABANDONED" },
  });
  if (updated.count === 0) {
    return Errors.validation("This session is already committed and cannot be cancelled.");
  }

  const session = await prisma.uploadSession.findUnique({
    where: { id },
    select: SESSION_SELECT,
  });
  if (!session) return Errors.internal();

  return ok({ session, items: [] });
}
