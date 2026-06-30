import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, Errors } from "@/lib/apiResponse";
import {
  authorizeUploadItem,
  assertSessionEditable,
  assertItemNotCommitted,
  normalizePromptStatus,
  fetchItemWithRelations,
} from "@/lib/uploadItem";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();

  const { id } = await params;
  const auth = await authorizeUploadItem(id, user.id);
  if (!auth.ok) {
    return auth.reason === "NOT_FOUND" ? Errors.notFound("Item not found") : Errors.forbidden();
  }

  const sessionErr = assertSessionEditable(auth.item.session.status);
  if (sessionErr) return Errors.validation(sessionErr);
  const commitErr = assertItemNotCommitted(auth.item.commitStatus);
  if (commitErr) return Errors.validation(commitErr);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Errors.validation("Invalid JSON");
  }

  if (typeof body.promptDraft !== "string") {
    return Errors.validation("promptDraft must be a string");
  }
  if (typeof body.saveMode !== "string") {
    return Errors.validation("saveMode must be 'draft' or 'filled'");
  }

  const promptDraft = body.promptDraft.trim();
  const { status: promptStatus, error: modeErr } = normalizePromptStatus(promptDraft, body.saveMode as string);
  if (modeErr) return Errors.validation(modeErr);

  await prisma.uploadItem.update({
    where: { id },
    data: { promptDraft: promptDraft || null, promptStatus },
  });

  const item = await fetchItemWithRelations(id);
  if (!item) return Errors.internal();
  return ok({ item });
}
