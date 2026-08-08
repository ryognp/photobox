// Phase 10-43-B3c-1: Storage cleanup 削除対象 path の allowlist / 再計算 / 検証の
// 唯一の pure contract。
//
// 確定契約（Frozen Plan B3c v2 §34）:
// - DB に保存された path を無検証で削除対象にしない。削除してよいのは、
//   server 所有の ID 群から既存 helper で再計算した期待値と DB 値が
//   「完全一致」した場合の、その **再計算済み expected path** だけ
// - path 文字列をこの module で再実装しない。正本は storagePaths.ts
//   （staging / temp / variants）と commitDecision.buildAssetPaths（assets）
// - 不一致・不正 ID は fail-closed（固定 reason のみ。raw path / 値 / ID を
//   result にも error にも含めない — 漏洩防止の関門）
// - live UploadItem が参照する canonical / variants、および正式 Image 行が
//   参照する asset は削除候補へ絶対に含めない
//
// purity: Prisma / Supabase / Storage / DB I/O なし・現在時刻なし。
// storagePaths.ts は `server-only` marker を持つため、本 module も transitive に
// server-only となるが、これは I/O を持たない server-domain module を意味する
// （vitest は server-only を stub 済み — 前例: validateImage）。path 文字列の
// 複製でこれを回避してはならない。

import {
  intentStagingOriginalPath,
  tempOriginalPath,
  tempThumbnailPath,
  tempPreviewPath,
  isSafePathSegment,
} from "./storagePaths";
import { buildAssetPaths } from "../commit/commitDecision";
import type { ImageExt } from "./validateImage";

// ---------------------------------------------------------------------------
// Result 形
// ---------------------------------------------------------------------------

export type CleanupPathKind =
  | "INTENT_STAGING_ORIGINAL"
  | "INTENT_CANONICAL_ORIGINAL"
  | "INTENT_THUMBNAIL"
  | "INTENT_PREVIEW"
  | "ITEM_TEMP_ORIGINAL"
  | "ITEM_TEMP_THUMBNAIL"
  | "ITEM_TEMP_PREVIEW"
  | "ITEM_ASSET_ORIGINAL"
  | "ITEM_ASSET_THUMBNAIL"
  | "ITEM_ASSET_PREVIEW";

export type CleanupPathEntry = {
  kind: CleanupPathKind;
  // 常に再計算済みの server-generated expected path（DB 値の echo ではない）。
  path: string;
};

export type CleanupPathFailureReason = "PATH_MISMATCH" | "IDENTITY_CORRUPT";

// 失敗 result は固定 reason のみ（offending path / 値 / ID を含めない）。
export type CleanupPathPlan =
  | { ok: true; entries: CleanupPathEntry[] }
  | { ok: false; reason: CleanupPathFailureReason };

const mismatch = (): CleanupPathPlan => ({ ok: false, reason: "PATH_MISMATCH" });
const corrupt = (): CleanupPathPlan => ({ ok: false, reason: "IDENTITY_CORRUPT" });

const IMAGE_EXTS: readonly ImageExt[] = ["jpg", "png", "webp"];

function isAllowedExt(ext: string): ext is ImageExt {
  return (IMAGE_EXTS as readonly string[]).includes(ext);
}

// ---------------------------------------------------------------------------
// A. Intent-owned paths（staging + orphan canonical / variants）
// ---------------------------------------------------------------------------

export type IntentCleanupPathInput = {
  workspaceId: string;
  sessionId: string;
  intentId: string;
  reservedUploadItemId: string;
  stagingOriginalPath: string;
  canonicalOriginalPath: string | null;
  liveUploadItemExists: boolean;
};

/**
 * intent が所有する削除対象 path の計画。
 * - staging は再計算値との完全一致を要求（常に対象）
 * - live UploadItem が存在する間、canonical / variants は対象にしない（C'）
 * - canonical path が null なら（path-before-PUT 不変条件により object は
 *   存在し得ないため）staging のみ
 * - orphan canonical は jpg/png/webp の 3 候補と厳密比較し、一致 ext の
 *   expected path + reserved item ID から導出した variants を対象にする
 */
export function planIntentCleanupPaths(input: IntentCleanupPathInput): CleanupPathPlan {
  for (const segment of [input.workspaceId, input.sessionId, input.intentId, input.reservedUploadItemId]) {
    if (!isSafePathSegment(segment)) return corrupt();
  }

  const expectedStaging = intentStagingOriginalPath(input.workspaceId, input.sessionId, input.intentId);
  if (input.stagingOriginalPath !== expectedStaging) return mismatch();

  const entries: CleanupPathEntry[] = [{ kind: "INTENT_STAGING_ORIGINAL", path: expectedStaging }];

  if (input.liveUploadItemExists || input.canonicalOriginalPath === null) {
    return { ok: true, entries };
  }

  let matchedExt: ImageExt | null = null;
  for (const ext of IMAGE_EXTS) {
    const candidate = tempOriginalPath(input.workspaceId, input.sessionId, input.reservedUploadItemId, ext);
    if (input.canonicalOriginalPath === candidate) {
      matchedExt = ext;
      break; // 3 候補は ext 部分だけが異なるため一致は高々 1 件
    }
  }
  if (matchedExt === null) return mismatch();

  entries.push(
    {
      kind: "INTENT_CANONICAL_ORIGINAL",
      path: tempOriginalPath(input.workspaceId, input.sessionId, input.reservedUploadItemId, matchedExt),
    },
    {
      kind: "INTENT_THUMBNAIL",
      path: tempThumbnailPath(input.workspaceId, input.sessionId, input.reservedUploadItemId),
    },
    {
      kind: "INTENT_PREVIEW",
      path: tempPreviewPath(input.workspaceId, input.sessionId, input.reservedUploadItemId),
    },
  );
  return { ok: true, entries };
}

// ---------------------------------------------------------------------------
// B. UploadItem temp paths（multipart / finalize 産の temp namespace）
// ---------------------------------------------------------------------------

export type ItemTempCleanupPathInput = {
  workspaceId: string;
  sessionId: string;
  uploadItemId: string;
  originalExt: string;
  tempStoragePath: string;
  tempThumbnailPath: string | null;
  tempPreviewPath: string | null;
};

export function planItemTempCleanupPaths(input: ItemTempCleanupPathInput): CleanupPathPlan {
  for (const segment of [input.workspaceId, input.sessionId, input.uploadItemId]) {
    if (!isSafePathSegment(segment)) return corrupt();
  }
  if (!isAllowedExt(input.originalExt)) return corrupt();

  const expectedOriginal = tempOriginalPath(
    input.workspaceId,
    input.sessionId,
    input.uploadItemId,
    input.originalExt,
  );
  if (input.tempStoragePath !== expectedOriginal) return mismatch();

  const entries: CleanupPathEntry[] = [{ kind: "ITEM_TEMP_ORIGINAL", path: expectedOriginal }];

  if (input.tempThumbnailPath !== null) {
    const expected = tempThumbnailPath(input.workspaceId, input.sessionId, input.uploadItemId);
    if (input.tempThumbnailPath !== expected) return mismatch();
    entries.push({ kind: "ITEM_TEMP_THUMBNAIL", path: expected });
  }
  if (input.tempPreviewPath !== null) {
    const expected = tempPreviewPath(input.workspaceId, input.sessionId, input.uploadItemId);
    if (input.tempPreviewPath !== expected) return mismatch();
    entries.push({ kind: "ITEM_TEMP_PREVIEW", path: expected });
  }
  return { ok: true, entries };
}

// ---------------------------------------------------------------------------
// C. Uncommitted commit orphan asset paths（assets namespace）
// ---------------------------------------------------------------------------

export type ItemAssetCleanupPathInput = {
  workspaceId: string;
  reservedImageId: string | null;
  originalExt: string;
  // buildAssetPaths の thumbnail / preview expected は temp path の有無で決まる。
  tempThumbnailPath: string | null;
  tempPreviewPath: string | null;
  assetStoragePath: string | null;
  assetThumbnailPath: string | null;
  assetPreviewPath: string | null;
  committedImageId: string | null;
  // 呼び出し側が images テーブルを reservedImageId で照会した結果。
  imageRowExists: boolean;
};

/**
 * commit 途中で crash した未 commit item の asset 残骸の計画。
 * - committedImageId が非 null、または正式 Image 行が存在する場合、asset は
 *   削除候補にしない（空 plan — 正式資産の保護が最優先）
 * - reservedImageId が null なのに asset path が 1 つでも非 null な行は
 *   identity 破損として fail-closed
 */
export function planItemAssetCleanupPaths(input: ItemAssetCleanupPathInput): CleanupPathPlan {
  if (input.committedImageId !== null || input.imageRowExists) {
    return { ok: true, entries: [] };
  }

  const anyAssetPath =
    input.assetStoragePath !== null || input.assetThumbnailPath !== null || input.assetPreviewPath !== null;

  if (input.reservedImageId === null) {
    if (anyAssetPath) return corrupt();
    return { ok: true, entries: [] };
  }

  if (!isSafePathSegment(input.workspaceId) || !isSafePathSegment(input.reservedImageId)) {
    return corrupt();
  }
  if (!isAllowedExt(input.originalExt)) return corrupt();

  const expected = buildAssetPaths({
    workspaceId: input.workspaceId,
    reservedImageId: input.reservedImageId,
    originalExt: input.originalExt,
    tempThumbnailPath: input.tempThumbnailPath,
    tempPreviewPath: input.tempPreviewPath,
  });

  const entries: CleanupPathEntry[] = [];

  if (input.assetStoragePath !== null) {
    if (input.assetStoragePath !== expected.assetStoragePath) return mismatch();
    entries.push({ kind: "ITEM_ASSET_ORIGINAL", path: expected.assetStoragePath });
  }
  if (input.assetThumbnailPath !== null) {
    if (expected.assetThumbnailPath === null) return mismatch();
    if (input.assetThumbnailPath !== expected.assetThumbnailPath) return mismatch();
    entries.push({ kind: "ITEM_ASSET_THUMBNAIL", path: expected.assetThumbnailPath });
  }
  if (input.assetPreviewPath !== null) {
    if (expected.assetPreviewPath === null) return mismatch();
    if (input.assetPreviewPath !== expected.assetPreviewPath) return mismatch();
    entries.push({ kind: "ITEM_ASSET_PREVIEW", path: expected.assetPreviewPath });
  }
  return { ok: true, entries };
}

// ---------------------------------------------------------------------------
// D. Deduplication（複数 source の plan 統合）
// ---------------------------------------------------------------------------

/**
 * 複数 plan を 1 つへ統合する。失敗 plan が 1 件でもあれば成功へ混ぜず、
 * 最初の失敗をそのまま返す（fail-closed）。path 文字列で dedup し、
 * 先勝ちで kind を維持する（挿入順 = 決定的順序）。
 */
export function mergeCleanupPathPlans(plans: readonly CleanupPathPlan[]): CleanupPathPlan {
  const entries: CleanupPathEntry[] = [];
  const seen = new Set<string>();
  for (const plan of plans) {
    if (!plan.ok) return { ok: false, reason: plan.reason };
    for (const entry of plan.entries) {
      if (seen.has(entry.path)) continue;
      seen.add(entry.path);
      entries.push({ kind: entry.kind, path: entry.path });
    }
  }
  return { ok: true, entries };
}
