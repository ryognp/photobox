import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, Errors } from "@/lib/apiResponse";
import {
  authorizeUploadItem,
  assertSessionEditable,
  assertItemNotCommitted,
  fetchItemWithRelations,
} from "@/lib/uploadItem";

export async function POST(
  _req: NextRequest,
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

  const item = await fetchItemWithRelations(id);
  if (!item) return Errors.internal();

  if (item.duplicateStatus !== "SKIPPED") {
    return Errors.validation("Item must have SKIPPED status to be unskipped");
  }

  const newStatus = item.duplicateImageId !== null ? "DUPLICATE" : "UNCHECKED";

  await prisma.uploadItem.update({
    where: { id },
    data: { duplicateStatus: newStatus },
  });

  const updated = await fetchItemWithRelations(id);
  if (!updated) return Errors.internal();
  return ok({ item: updated });
}
