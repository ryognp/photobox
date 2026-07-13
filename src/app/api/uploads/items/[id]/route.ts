import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { ok, Errors } from "@/lib/apiResponse";
import { checkUserRateLimit, rateLimitHeaders } from "@/lib/rateLimit";
import {
  authorizeUploadItem,
  assertSessionEditable,
  assertItemNotCommitted,
  fetchItemWithRelations,
} from "@/lib/uploadItem";
import { collectUploadItemStoragePaths } from "@/lib/quick-add/uploadItemDelete";

const BUCKET = "photobox-private";

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

// ---- DELETE -----------------------------------------------------------
//
// Phase 10-19A: deletes a single UploadItem from the Quick Add preview.
// Storage-first: temp Storage objects are removed BEFORE the DB row, so a
// Storage failure never leaves an orphaned DB row pointing at deleted paths
// (unlike the async cleanup cron, which tolerates eventual consistency —
// this is a synchronous user action and must not silently drop data).
//
// Review fix: deletable commitStatus is PENDING/FAILED ONLY — IN_PROGRESS is
// excluded because the commit API may be actively reading/writing this
// item's temp Storage paths while committing; deleting them mid-commit would
// corrupt that in-flight operation. committedImageId !== null is also
// rejected (belt-and-suspenders alongside the commitStatus check — a
// COMMITTED/skip-completed item always has this set). All of this is
// re-checked against a FRESH read right before the Storage call, not just
// authorizeUploadItem's snapshot, to close the race window between auth and
// deletion. Committed Image rows, Tag/Person/Scene masters, and
// ImageTag/ImagePerson are never touched here — only the UploadItem row and
// its own temp Storage objects.
export async function DELETE(
  _request: NextRequest,
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

  const rl = await checkUserRateLimit({
    preset: "uploadItemDelete",
    userId: user.id,
    workspaceId: auth.item.workspaceId,
  });
  if (!rl.allowed) return Errors.rateLimited(rateLimitHeaders(rl));

  // 認可チェック後、Storage削除の直前にDB状態を再取得して最終判定する
  // (auth.itemの古いsnapshotだけに依存しない — commit処理と競合するレースを狭める)。
  const current = await prisma.uploadItem.findUnique({
    where: { id },
    select: {
      sessionId: true,
      commitStatus: true,
      committedImageId: true,
      tempStoragePath: true,
      tempThumbnailPath: true,
      tempPreviewPath: true,
      session: { select: { status: true } },
    },
  });
  if (!current) return Errors.notFound("Item not found");

  if (current.session.status !== "ACTIVE" && current.session.status !== "PREVIEWING") {
    return Errors.validation(
      `Session status is '${current.session.status}'. Only ACTIVE or PREVIEWING sessions can be edited.`,
    );
  }
  if (current.commitStatus !== "PENDING" && current.commitStatus !== "FAILED") {
    return Errors.validation(
      `Item commitStatus is '${current.commitStatus}'. Only PENDING or FAILED items can be deleted.`,
    );
  }
  if (current.committedImageId !== null) {
    return Errors.validation("This item has already been committed and cannot be deleted.");
  }

  const paths = collectUploadItemStoragePaths(current);
  if (paths.length > 0) {
    const { error } = await supabaseAdmin.storage.from(BUCKET).remove(paths);
    if (error) {
      // Storage削除失敗時はDB itemを削除しない(orphan DBを避ける)。
      return Errors.internal();
    }
  }

  // 安全弁: commitStatus/committedImageIdが上のチェックと同時に変化していても、
  // ここで条件を満たさなければ削除0件になる(deleteMany は例外を投げない)。
  const deleted = await prisma.uploadItem.deleteMany({
    where: { id, commitStatus: { in: ["PENDING", "FAILED"] }, committedImageId: null },
  });
  if (deleted.count === 0) {
    return Errors.conflict("This item is being committed or was already committed/deleted.");
  }

  const sessionId = current.sessionId;
  const remainingCount = await prisma.uploadItem.count({ where: { sessionId } });

  let sessionEmpty = false;
  if (remainingCount === 0) {
    await prisma.uploadSession.updateMany({
      where: { id: sessionId, status: { in: ["ACTIVE", "PREVIEWING"] } },
      data: { status: "ABANDONED" },
    });
    sessionEmpty = true;
  }

  return ok({ deletedItemId: id, sessionId, sessionEmpty });
}
