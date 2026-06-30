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

// ---- GET ------------------------------------------------------------------

export async function GET(
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

  const item = await fetchItemWithRelations(id);
  if (!item) return Errors.internal();
  return ok({ item });
}

// ---- PATCH ----------------------------------------------------------------

export async function PATCH(
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

  const workspaceId = auth.item.workspaceId;

  // ---- sceneId ----
  let sceneId: string | null | undefined = undefined;
  if ("sceneId" in body) {
    const raw = body.sceneId;
    if (raw === null) {
      sceneId = null;
    } else if (typeof raw === "string") {
      const scene = await prisma.scene.findFirst({
        where: { id: raw, workspaceId },
        select: { id: true },
      });
      if (!scene) return Errors.validation(`Scene '${raw}' not found in this workspace`);
      sceneId = raw;
    } else {
      return Errors.validation("sceneId must be a string or null");
    }
  }

  // ---- tagIds ----
  let tagIds: string[] | undefined = undefined;
  if ("tagIds" in body) {
    const raw = body.tagIds;
    if (!Array.isArray(raw)) return Errors.validation("tagIds must be an array");
    const unique = [...new Set(raw.filter((v): v is string => typeof v === "string"))];
    if (unique.length > 0) {
      const found = await prisma.tag.findMany({
        where: { id: { in: unique }, workspaceId },
        select: { id: true },
      });
      if (found.length !== unique.length) {
        return Errors.validation("Some tagIds not found in this workspace");
      }
    }
    tagIds = unique;
  }

  // ---- personIds ----
  let personIds: string[] | undefined = undefined;
  if ("personIds" in body) {
    const raw = body.personIds;
    if (!Array.isArray(raw)) return Errors.validation("personIds must be an array");
    const unique = [...new Set(raw.filter((v): v is string => typeof v === "string"))];
    if (unique.length > 0) {
      const found = await prisma.person.findMany({
        where: { id: { in: unique }, workspaceId },
        select: { id: true },
      });
      if (found.length !== unique.length) {
        return Errors.validation("Some personIds not found in this workspace");
      }
    }
    personIds = unique;
  }

  // ---- rating ----
  let rating: number | null | undefined = undefined;
  if ("rating" in body) {
    const raw = body.rating;
    if (raw === null) {
      rating = null;
    } else if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 5) {
      rating = raw;
    } else {
      return Errors.validation("rating must be null or an integer between 1 and 5");
    }
  }

  // ---- isFavorite ----
  let isFavorite: boolean | undefined = undefined;
  if ("isFavorite" in body) {
    if (typeof body.isFavorite !== "boolean") return Errors.validation("isFavorite must be a boolean");
    isFavorite = body.isFavorite;
  }

  // ---- notes ----
  let notes: string | null | undefined = undefined;
  if ("notes" in body) {
    const raw = body.notes;
    if (raw === null) {
      notes = null;
    } else if (typeof raw === "string") {
      notes = raw.trim() || null;
    } else {
      return Errors.validation("notes must be a string or null");
    }
  }

  // ---- DB transaction ----
  await prisma.$transaction(async (tx) => {
    // scalar fields
    const scalarUpdates: Record<string, unknown> = {};
    if (sceneId !== undefined) scalarUpdates.sceneId = sceneId;
    if (rating !== undefined) scalarUpdates.rating = rating;
    if (isFavorite !== undefined) scalarUpdates.isFavorite = isFavorite;
    if (notes !== undefined) scalarUpdates.notes = notes;

    if (Object.keys(scalarUpdates).length > 0) {
      await tx.uploadItem.update({ where: { id }, data: scalarUpdates });
    }

    // tags の全置換
    if (tagIds !== undefined) {
      await tx.uploadItemTag.deleteMany({ where: { uploadItemId: id } });
      if (tagIds.length > 0) {
        await tx.uploadItemTag.createMany({
          data: tagIds.map((tagId) => ({ uploadItemId: id, tagId, workspaceId })),
          skipDuplicates: true,
        });
      }
    }

    // persons の全置換
    if (personIds !== undefined) {
      await tx.uploadItemPerson.deleteMany({ where: { uploadItemId: id } });
      if (personIds.length > 0) {
        await tx.uploadItemPerson.createMany({
          data: personIds.map((personId) => ({ uploadItemId: id, personId, workspaceId })),
          skipDuplicates: true,
        });
      }
    }
  });

  const item = await fetchItemWithRelations(id);
  if (!item) return Errors.internal();
  return ok({ item });
}
