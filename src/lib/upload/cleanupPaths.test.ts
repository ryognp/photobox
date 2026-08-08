// Phase 10-43-B3c-1: cleanupPaths の unit test。
// expected path は production helper から再取得せず、独立した literal で
// assert する（循環 oracle の禁止）。

import { describe, it, expect } from "vitest";
import {
  planIntentCleanupPaths,
  planItemTempCleanupPaths,
  planItemAssetCleanupPaths,
  mergeCleanupPathPlans,
  type IntentCleanupPathInput,
  type ItemTempCleanupPathInput,
  type ItemAssetCleanupPathInput,
  type CleanupPathPlan,
} from "./cleanupPaths";

const WS = "ws01";
const SID = "sess01";
const IID = "intent01";
const RITEM = "item01";
const RIMG = "rimg01";

// 独立 literal（storagePaths / buildAssetPaths の期待形式を直書き）
const STAGING = "ws01/upload-intents/sess01/intent01/original";
const CANON_JPG = "ws01/uploads/sess01/item01/original.jpg";
const CANON_PNG = "ws01/uploads/sess01/item01/original.png";
const CANON_WEBP = "ws01/uploads/sess01/item01/original.webp";
const THUMB = "ws01/uploads/sess01/item01/thumbnail.webp";
const PREVIEW = "ws01/uploads/sess01/item01/preview.webp";
const ASSET_ORIG_PNG = "ws01/assets/rimg01/original.png";
const ASSET_THUMB = "ws01/assets/rimg01/thumbnail.webp";
const ASSET_PREVIEW = "ws01/assets/rimg01/preview.webp";

const SENTINEL = "SENTINEL_RAW_PATH_98765";

const intentInput = (over: Partial<IntentCleanupPathInput> = {}): IntentCleanupPathInput => ({
  workspaceId: WS,
  sessionId: SID,
  intentId: IID,
  reservedUploadItemId: RITEM,
  stagingOriginalPath: STAGING,
  canonicalOriginalPath: null,
  liveUploadItemExists: false,
  ...over,
});

const itemInput = (over: Partial<ItemTempCleanupPathInput> = {}): ItemTempCleanupPathInput => ({
  workspaceId: WS,
  sessionId: SID,
  uploadItemId: RITEM,
  originalExt: "jpg",
  tempStoragePath: CANON_JPG,
  tempThumbnailPath: THUMB,
  tempPreviewPath: PREVIEW,
  ...over,
});

const assetInput = (over: Partial<ItemAssetCleanupPathInput> = {}): ItemAssetCleanupPathInput => ({
  workspaceId: WS,
  reservedImageId: RIMG,
  originalExt: "png",
  tempThumbnailPath: THUMB,
  tempPreviewPath: PREVIEW,
  assetStoragePath: ASSET_ORIG_PNG,
  assetThumbnailPath: ASSET_THUMB,
  assetPreviewPath: ASSET_PREVIEW,
  committedImageId: null,
  imageRowExists: false,
  ...over,
});

// ---------------------------------------------------------------------------
// Intent-owned
// ---------------------------------------------------------------------------

describe("planIntentCleanupPaths", () => {
  it("valid staging（canonical なし）は staging 1 件の expected path を返す", () => {
    expect(planIntentCleanupPaths(intentInput())).toEqual({
      ok: true,
      entries: [{ kind: "INTENT_STAGING_ORIGINAL", path: STAGING }],
    });
  });

  it("staging mismatch は PATH_MISMATCH（fail-closed・raw path 非露出）", () => {
    const r = planIntentCleanupPaths(intentInput({ stagingOriginalPath: `${WS}/${SENTINEL}` }));
    expect(r).toEqual({ ok: false, reason: "PATH_MISMATCH" });
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
  });

  it.each([
    ["workspace", { workspaceId: "../evil" }],
    ["session", { sessionId: "a/b" }],
    ["intent", { intentId: "x" + String.fromCharCode(0) + "y" }],
    ["reservedUploadItemId", { reservedUploadItemId: "a.b" }],
  ] as const)("unsafe %s ID は IDENTITY_CORRUPT", (_label, over) => {
    expect(planIntentCleanupPaths(intentInput(over))).toEqual({
      ok: false,
      reason: "IDENTITY_CORRUPT",
    });
  });

  it("live UploadItem が存在する間は canonical / variants を対象にしない", () => {
    const r = planIntentCleanupPaths(
      intentInput({ canonicalOriginalPath: CANON_JPG, liveUploadItemExists: true }),
    );
    expect(r).toEqual({
      ok: true,
      entries: [{ kind: "INTENT_STAGING_ORIGINAL", path: STAGING }],
    });
  });

  it.each([
    ["jpg", CANON_JPG],
    ["png", CANON_PNG],
    ["webp", CANON_WEBP],
  ])("orphan canonical (%s) は canonical + 導出 variants を追加する", (_ext, canonical) => {
    const r = planIntentCleanupPaths(intentInput({ canonicalOriginalPath: canonical }));
    expect(r).toEqual({
      ok: true,
      entries: [
        { kind: "INTENT_STAGING_ORIGINAL", path: STAGING },
        { kind: "INTENT_CANONICAL_ORIGINAL", path: canonical },
        { kind: "INTENT_THUMBNAIL", path: THUMB },
        { kind: "INTENT_PREVIEW", path: PREVIEW },
      ],
    });
  });

  it.each([
    ["unknown ext", "ws01/uploads/sess01/item01/original.gif"],
    ["別workspace", "ws02/uploads/sess01/item01/original.jpg"],
    ["別session", "ws01/uploads/sess02/item01/original.jpg"],
    ["別item", "ws01/uploads/sess01/item99/original.jpg"],
    ["traversal", "ws01/uploads/sess01/../item01/original.jpg"],
    ["staging namespace 混入", "ws01/upload-intents/sess01/intent01/original"],
  ])("canonical %s は PATH_MISMATCH", (_label, canonical) => {
    expect(planIntentCleanupPaths(intentInput({ canonicalOriginalPath: canonical }))).toEqual({
      ok: false,
      reason: "PATH_MISMATCH",
    });
  });
});

// ---------------------------------------------------------------------------
// Item temp
// ---------------------------------------------------------------------------

describe("planItemTempCleanupPaths", () => {
  it("original + thumbnail + preview が全て一致すれば 3 件", () => {
    expect(planItemTempCleanupPaths(itemInput())).toEqual({
      ok: true,
      entries: [
        { kind: "ITEM_TEMP_ORIGINAL", path: CANON_JPG },
        { kind: "ITEM_TEMP_THUMBNAIL", path: THUMB },
        { kind: "ITEM_TEMP_PREVIEW", path: PREVIEW },
      ],
    });
  });

  it("variant null は skip（original のみ）", () => {
    expect(
      planItemTempCleanupPaths(itemInput({ tempThumbnailPath: null, tempPreviewPath: null })),
    ).toEqual({
      ok: true,
      entries: [{ kind: "ITEM_TEMP_ORIGINAL", path: CANON_JPG }],
    });
  });

  it("invalid ext は IDENTITY_CORRUPT", () => {
    expect(planItemTempCleanupPaths(itemInput({ originalExt: "gif" }))).toEqual({
      ok: false,
      reason: "IDENTITY_CORRUPT",
    });
    expect(planItemTempCleanupPaths(itemInput({ originalExt: "JPG" }))).toEqual({
      ok: false,
      reason: "IDENTITY_CORRUPT",
    });
  });

  it.each([
    ["original", { tempStoragePath: `ws01/uploads/sess01/item01/${SENTINEL}.jpg` }],
    ["thumbnail", { tempThumbnailPath: `ws01/uploads/sess01/${SENTINEL}/thumbnail.webp` }],
    ["preview", { tempPreviewPath: `ws01/uploads/sess01/item01/preview.jpeg` }],
  ] as const)("%s mismatch は PATH_MISMATCH・raw path 非露出", (_label, over) => {
    const r = planItemTempCleanupPaths(itemInput(over));
    expect(r).toEqual({ ok: false, reason: "PATH_MISMATCH" });
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
  });

  it("unsafe item ID は IDENTITY_CORRUPT", () => {
    expect(planItemTempCleanupPaths(itemInput({ uploadItemId: "a/b" }))).toEqual({
      ok: false,
      reason: "IDENTITY_CORRUPT",
    });
  });
});

// ---------------------------------------------------------------------------
// Asset orphan
// ---------------------------------------------------------------------------

describe("planItemAssetCleanupPaths", () => {
  it("committedImageId が非 null なら削除候補 0（正式資産の保護）", () => {
    expect(planItemAssetCleanupPaths(assetInput({ committedImageId: "img99" }))).toEqual({
      ok: true,
      entries: [],
    });
  });

  it("正式 Image 行が存在するなら削除候補 0", () => {
    expect(planItemAssetCleanupPaths(assetInput({ imageRowExists: true }))).toEqual({
      ok: true,
      entries: [],
    });
  });

  it("reservedImageId null + asset 全 null は空 plan", () => {
    expect(
      planItemAssetCleanupPaths(
        assetInput({
          reservedImageId: null,
          assetStoragePath: null,
          assetThumbnailPath: null,
          assetPreviewPath: null,
        }),
      ),
    ).toEqual({ ok: true, entries: [] });
  });

  it("reservedImageId null なのに asset path が非 null なら IDENTITY_CORRUPT", () => {
    expect(
      planItemAssetCleanupPaths(
        assetInput({ reservedImageId: null, assetThumbnailPath: ASSET_THUMB, assetStoragePath: null, assetPreviewPath: null }),
      ),
    ).toEqual({ ok: false, reason: "IDENTITY_CORRUPT" });
  });

  it("valid asset 3 path は expected 3 件", () => {
    expect(planItemAssetCleanupPaths(assetInput())).toEqual({
      ok: true,
      entries: [
        { kind: "ITEM_ASSET_ORIGINAL", path: ASSET_ORIG_PNG },
        { kind: "ITEM_ASSET_THUMBNAIL", path: ASSET_THUMB },
        { kind: "ITEM_ASSET_PREVIEW", path: ASSET_PREVIEW },
      ],
    });
  });

  it("partial（original のみ永続化済み）は 1 件", () => {
    expect(
      planItemAssetCleanupPaths(assetInput({ assetThumbnailPath: null, assetPreviewPath: null })),
    ).toEqual({
      ok: true,
      entries: [{ kind: "ITEM_ASSET_ORIGINAL", path: ASSET_ORIG_PNG }],
    });
  });

  it.each([
    ["original", { assetStoragePath: "ws01/assets/rimg01/original.jpg" }],
    ["thumbnail", { assetThumbnailPath: `ws01/assets/${SENTINEL}/thumbnail.webp` }],
    ["preview", { assetPreviewPath: "ws01/assets/rimg01/preview.png" }],
  ] as const)("asset %s mismatch は PATH_MISMATCH・raw path 非露出", (_label, over) => {
    const r = planItemAssetCleanupPaths(assetInput(over));
    expect(r).toEqual({ ok: false, reason: "PATH_MISMATCH" });
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
  });

  it("expected variant が null（temp が無い）のに DB asset variant が非 null なら PATH_MISMATCH", () => {
    expect(
      planItemAssetCleanupPaths(assetInput({ tempThumbnailPath: null, assetThumbnailPath: ASSET_THUMB })),
    ).toEqual({ ok: false, reason: "PATH_MISMATCH" });
  });

  it("unsafe reservedImageId / invalid ext は IDENTITY_CORRUPT", () => {
    expect(planItemAssetCleanupPaths(assetInput({ reservedImageId: "a/b" }))).toEqual({
      ok: false,
      reason: "IDENTITY_CORRUPT",
    });
    expect(planItemAssetCleanupPaths(assetInput({ originalExt: "gif" }))).toEqual({
      ok: false,
      reason: "IDENTITY_CORRUPT",
    });
  });
});

// ---------------------------------------------------------------------------
// Dedup / privacy / immutability
// ---------------------------------------------------------------------------

describe("mergeCleanupPathPlans", () => {
  const okPlan = (kind: "INTENT_STAGING_ORIGINAL" | "ITEM_TEMP_ORIGINAL", path: string): CleanupPathPlan => ({
    ok: true,
    entries: [{ kind, path }],
  });

  it("duplicate path は 1 件化・先勝ち kind・挿入順維持", () => {
    const merged = mergeCleanupPathPlans([
      okPlan("INTENT_STAGING_ORIGINAL", STAGING),
      okPlan("ITEM_TEMP_ORIGINAL", CANON_JPG),
      okPlan("ITEM_TEMP_ORIGINAL", STAGING), // duplicate path・別 kind
    ]);
    expect(merged).toEqual({
      ok: true,
      entries: [
        { kind: "INTENT_STAGING_ORIGINAL", path: STAGING },
        { kind: "ITEM_TEMP_ORIGINAL", path: CANON_JPG },
      ],
    });
  });

  it("mismatch plan を成功へ混ぜない（最初の失敗を返す）", () => {
    expect(
      mergeCleanupPathPlans([
        okPlan("INTENT_STAGING_ORIGINAL", STAGING),
        { ok: false, reason: "PATH_MISMATCH" },
        { ok: false, reason: "IDENTITY_CORRUPT" },
      ]),
    ).toEqual({ ok: false, reason: "PATH_MISMATCH" });
  });

  it("決定性: 同一入力は同一出力", () => {
    const plans = [okPlan("INTENT_STAGING_ORIGINAL", STAGING), okPlan("ITEM_TEMP_ORIGINAL", CANON_JPG)];
    expect(mergeCleanupPathPlans(plans)).toEqual(mergeCleanupPathPlans(plans));
  });
});

describe("privacy / result shape / immutability", () => {
  it("成功 result の key / shape が固定されている", () => {
    const r = planIntentCleanupPaths(intentInput());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r).sort()).toEqual(["entries", "ok"]);
      for (const e of r.entries) expect(Object.keys(e).sort()).toEqual(["kind", "path"]);
    }
  });

  it("ID sentinel が失敗 result へ現れない", () => {
    const r = planIntentCleanupPaths(
      intentInput({ intentId: "EVIL SENTINEL ID" }), // 空白で unsafe
    );
    expect(r).toEqual({ ok: false, reason: "IDENTITY_CORRUPT" });
    expect(JSON.stringify(r)).not.toContain("SENTINEL");
  });

  it("返却 entries を破壊しても次回結果へ漏れない（shared mutable なし）", () => {
    const r1 = planIntentCleanupPaths(intentInput());
    expect(r1.ok).toBe(true);
    if (r1.ok) r1.entries.length = 0;
    const r2 = planIntentCleanupPaths(intentInput());
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.entries).toHaveLength(1);
  });

  it("DB path をそのまま返すのではなく再計算値を返す（同値だが独立に検証）", () => {
    // 一致した場合の返却値は expected literal と等しい
    const r = planItemTempCleanupPaths(itemInput());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entries.map((e) => e.path)).toEqual([CANON_JPG, THUMB, PREVIEW]);
    }
  });
});
