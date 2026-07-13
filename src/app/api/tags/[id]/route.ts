import "server-only";

import { NextRequest } from "next/server";
import { getCurrentUser, getDefaultWorkspaceForUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, Errors } from "@/lib/apiResponse";

// Phase 10-20B: 使用中(imageCount>0)のTagも、明示的な `force: true` を渡した
// 場合のみ削除できるようにする。ImageTag/UploadItemTagはTagから
// onDelete:Cascade、TagSuggestion.approvedTagIdはonDelete:SetNullのため、
// `prisma.tag.delete()` 単体でこれらのjoin/参照が既存schema通り自動的に
// 処理される — Image本体・Storage・他Tagには一切影響しない。
//
// レビュー修正: force削除は破壊的操作のため、UIのチェックボックス同意だけに
// 頼らず、サーバー側でも `confirmName` がTag名と完全一致することを必須にする
// (API直叩き・誤実装・将来の別UIからの無確認削除を防ぐ)。trim()はしない —
// 完全一致のみを許可する。
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();

  const workspace = await getDefaultWorkspaceForUser(user.id);
  if (!workspace) return Errors.forbidden();

  const { id } = await params;

  // DELETEにbodyは必須ではない(imageCount=0の既存フローはbodyなしで呼ばれる)。
  // 不正/空JSONは force=false 扱いにするだけで、エラーにはしない。
  let force = false;
  let confirmName: string | null = null;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    force = body.force === true;
    confirmName = typeof body.confirmName === "string" ? body.confirmName : null;
  } catch {
    // no body / invalid JSON → force=false
  }

  const tag = await prisma.tag.findFirst({
    where: { id, workspaceId: workspace.id },
    select: {
      id: true,
      name: true,
      _count: { select: { imageTags: true, uploadItemTags: true } },
    },
  });
  if (!tag) return Errors.notFound("Tag not found");

  const linkedImageCount = tag._count.imageTags;
  const linkedUploadItemCount = tag._count.uploadItemTags;

  if (linkedImageCount > 0 && !force) {
    return Errors.validation(
      `このタグには ${linkedImageCount} 枚の画像が紐づいているため削除できません。統合を使ってください。`,
    );
  }

  if (force && confirmName !== tag.name) {
    return Errors.validation("confirmName must exactly match the tag name");
  }

  await prisma.tag.delete({ where: { id } });
  return ok({
    deleted: true,
    deletedTagId: tag.id,
    name: tag.name,
    unlinkedImageCount: linkedImageCount,
    unlinkedUploadItemCount: linkedUploadItemCount,
    forced: force,
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();

  const workspace = await getDefaultWorkspaceForUser(user.id);
  if (!workspace) return Errors.forbidden();

  const { id } = await params;

  const existing = await prisma.tag.findFirst({
    where: { id, workspaceId: workspace.id },
    select: { id: true },
  });
  if (!existing) return Errors.notFound("Tag not found");

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Errors.validation("Invalid JSON");
  }

  if (!("name" in body)) return Errors.validation("No fields to update");

  const trimmed = typeof body.name === "string" ? body.name.trim() : "";
  if (!trimmed) return Errors.validation("name cannot be empty");

  const conflict = await prisma.tag.findFirst({
    where: { workspaceId: workspace.id, name: trimmed, NOT: { id } },
    select: { id: true },
  });
  if (conflict) return Errors.conflict(`Tag "${trimmed}" already exists`);

  const tag = await prisma.tag.update({
    where: { id },
    data: { name: trimmed },
    select: { id: true, name: true, createdAt: true },
  });

  return ok(tag);
}
