// Phase 10-43-B3a: variant profile v1 の正本定義と生成器の unit test。
// binary fixture なし — 画像は test 実行時に sharp で生成。
// 「独立失敗」の検証だけは sharp を動的 mock した隔離 import で行う
// （実 sharp では spec 依存の片側失敗を注入できないため）。

import { describe, it, expect, beforeAll, vi } from "vitest";
import sharp from "sharp";
import { CURRENT_VARIANT_PROFILE_VERSION } from "./uploadIntentCore";
import { getVariantProfile, generateVariants } from "./variantProfile";

let landscape1200x600: Buffer;
let portrait600x1200: Buffer;
let square500: Buffer;
let small100x50: Buffer;
let alphaPng: Buffer;
let oriented6Jpeg: Buffer; // 40x20 coded + orientation 6 → 表示 20x40
let animatedWebp: Buffer;

beforeAll(async () => {
  const make = (w: number, h: number) =>
    sharp({ create: { width: w, height: h, channels: 3, background: { r: 30, g: 120, b: 210 } } })
      .jpeg()
      .toBuffer();
  landscape1200x600 = await make(1200, 600);
  portrait600x1200 = await make(600, 1200);
  square500 = await make(500, 500);
  small100x50 = await make(100, 50);
  alphaPng = await sharp({ create: { width: 400, height: 400, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.4 } } })
    .png()
    .toBuffer();
  oriented6Jpeg = await sharp({ create: { width: 40, height: 20, channels: 3, background: { r: 90, g: 90, b: 90 } } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const frameA = await sharp({ create: { width: 12, height: 12, channels: 3, background: { r: 255, g: 0, b: 0 } } })
    .webp()
    .toBuffer();
  const frameB = await sharp({ create: { width: 12, height: 12, channels: 3, background: { r: 0, g: 255, b: 0 } } })
    .webp()
    .toBuffer();
  animatedWebp = await sharp([frameA, frameB], { join: { animated: true } })
    .webp()
    .toBuffer();
});

describe("variant profile registry", () => {
  it("v1 の正確な仕様（maxEdge / quality）が固定されている", () => {
    const profile = getVariantProfile(CURRENT_VARIANT_PROFILE_VERSION);
    expect(profile).toEqual({
      thumbnail: { maxEdge: 300, quality: 85 },
      preview: { maxEdge: 800, quality: 90 },
    });
  });

  it("unknown version は null（v1 へ fallback しない）", () => {
    expect(getVariantProfile("v999")).toBeNull();
    expect(getVariantProfile("")).toBeNull();
    expect(getVariantProfile("V1")).toBeNull(); // 大文字も別物
  });

  // registry は plain object であり prototype chain を持つ。単純な index access
  // や `in` 演算子では Object.prototype 由来の値（関数）を「既知 profile」と
  // 誤認識し得るため、own-property のみを有効とする guard を固定する。
  it.each(["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__", "prototype"])(
    "Object.prototype 由来キー %s は own-property ではないため null",
    (key) => {
      expect(getVariantProfile(key)).toBeNull();
    },
  );
});

describe("generateVariants — v1 寸法契約", () => {
  it("landscape 1200×600: thumbnail は長辺300、preview は長辺800", async () => {
    const r = await generateVariants(landscape1200x600, CURRENT_VARIANT_PROFILE_VERSION);
    expect(r.profileKnown).toBe(true);
    expect(r.thumbnail.ok && [r.thumbnail.width, r.thumbnail.height]).toEqual([300, 150]);
    expect(r.preview.ok && [r.preview.width, r.preview.height]).toEqual([800, 400]);
  });

  it("portrait 600×1200: 長辺=高さ基準で縮小", async () => {
    const r = await generateVariants(portrait600x1200, CURRENT_VARIANT_PROFILE_VERSION);
    expect(r.thumbnail.ok && [r.thumbnail.width, r.thumbnail.height]).toEqual([150, 300]);
    expect(r.preview.ok && [r.preview.width, r.preview.height]).toEqual([400, 800]);
  });

  it("square 500×500: thumbnail 300×300、preview は拡大せず 500×500", async () => {
    const r = await generateVariants(square500, CURRENT_VARIANT_PROFILE_VERSION);
    expect(r.thumbnail.ok && [r.thumbnail.width, r.thumbnail.height]).toEqual([300, 300]);
    expect(r.preview.ok && [r.preview.width, r.preview.height]).toEqual([500, 500]);
  });

  it("小さい画像 100×50 は拡大しない（withoutEnlargement）", async () => {
    const r = await generateVariants(small100x50, CURRENT_VARIANT_PROFILE_VERSION);
    expect(r.thumbnail.ok && [r.thumbnail.width, r.thumbnail.height]).toEqual([100, 50]);
    expect(r.preview.ok && [r.preview.width, r.preview.height]).toEqual([100, 50]);
  });

  it("alpha PNG も WebP variant を生成できる", async () => {
    const r = await generateVariants(alphaPng, CURRENT_VARIANT_PROFILE_VERSION);
    expect(r.thumbnail.ok).toBe(true);
    expect(r.preview.ok).toBe(true);
  });

  it("output は WebP（mimeType と実バイトの magic 両方）", async () => {
    const r = await generateVariants(square500, CURRENT_VARIANT_PROFILE_VERSION);
    for (const v of [r.thumbnail, r.preview]) {
      expect(v.ok).toBe(true);
      if (v.ok) {
        expect(v.mimeType).toBe("image/webp");
        // RIFF....WEBP
        expect(v.buffer.subarray(0, 4).toString("ascii")).toBe("RIFF");
        expect(v.buffer.subarray(8, 12).toString("ascii")).toBe("WEBP");
      }
    }
  });

  it("EXIF orientation を variant へ焼き込む（orientation 6 → 表示 20×40）", async () => {
    const r = await generateVariants(oriented6Jpeg, CURRENT_VARIANT_PROFILE_VERSION);
    expect(r.thumbnail.ok && [r.thumbnail.width, r.thumbnail.height]).toEqual([20, 40]);
  });
});

describe("generateVariants — 決定性と option 固定", () => {
  it("同一入力・同一profileの再生成は byte 同一（再現性）", async () => {
    const a = await generateVariants(square500, CURRENT_VARIANT_PROFILE_VERSION);
    const b = await generateVariants(square500, CURRENT_VARIANT_PROFILE_VERSION);
    expect(a.thumbnail.ok && b.thumbnail.ok && a.thumbnail.buffer.equals(b.thumbnail.buffer)).toBe(true);
    expect(a.preview.ok && b.preview.ok && a.preview.buffer.equals(b.preview.buffer)).toBe(true);
  });

  it("出力は「rotate→resize(inside/非拡大)→webp(q85/q90)」の参照pipelineと byte 一致（quality/fit/rotate の mutation を検知）", async () => {
    const r = await generateVariants(landscape1200x600, CURRENT_VARIANT_PROFILE_VERSION);
    const refThumb = await sharp(landscape1200x600)
      .rotate()
      .resize(300, 300, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();
    const refPreview = await sharp(landscape1200x600)
      .rotate()
      .resize(800, 800, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 90 })
      .toBuffer();
    expect(r.thumbnail.ok && r.thumbnail.buffer.equals(refThumb)).toBe(true);
    expect(r.preview.ok && r.preview.buffer.equals(refPreview)).toBe(true);
    // quality を取り違えた pipeline とは一致しない（85⇔90 の mutation 検知）
    const wrongQualityThumb = await sharp(landscape1200x600)
      .rotate()
      .resize(300, 300, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 90 })
      .toBuffer();
    expect(r.thumbnail.ok && r.thumbnail.buffer.equals(wrongQualityThumb)).toBe(false);
  });

  it("original buffer を変更しない", async () => {
    const before = Buffer.from(square500);
    await generateVariants(square500, CURRENT_VARIANT_PROFILE_VERSION);
    expect(square500.equals(before)).toBe(true);
  });
});

describe("generateVariants — 失敗契約", () => {
  it("unknown profile では sharp 処理を開始しない（不正入力でも UNKNOWN_PROFILE のまま）", async () => {
    // sharp が呼ばれていれば GENERATION_FAILED になるはずの garbage 入力で確認
    const garbage = Buffer.from("definitely not an image");
    const r = await generateVariants(garbage, "v999");
    expect(r).toEqual({
      profileKnown: false,
      thumbnail: { ok: false, reason: "UNKNOWN_PROFILE" },
      preview: { ok: false, reason: "UNKNOWN_PROFILE" },
    });
  });

  it.each(["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__", "prototype"])(
    "Object.prototype 由来キー %s は generateVariants でも UNKNOWN_PROFILE・sharp 呼び出しゼロ",
    async (key) => {
      vi.resetModules();
      let sharpCallCount = 0;
      vi.doMock("sharp", () => ({
        default: (...args: unknown[]) => {
          sharpCallCount++;
          throw new Error(`sharp should not be invoked for prototype key (called with ${args.length} args)`);
        },
      }));
      try {
        const { generateVariants: gen } = await import("./variantProfile");
        // garbage 入力（本物の画像でなくても sharp 未起動なら到達しないはず）
        const r = await gen(Buffer.from("garbage"), key);
        expect(r).toEqual({
          profileKnown: false,
          thumbnail: { ok: false, reason: "UNKNOWN_PROFILE" },
          preview: { ok: false, reason: "UNKNOWN_PROFILE" },
        });
        expect(sharpCallCount).toBe(0);
      } finally {
        vi.doUnmock("sharp");
        vi.resetModules();
      }
    },
  );

  it("animated 入力は先頭 frame を暗黙採用せず両 variant を拒否", async () => {
    const r = await generateVariants(animatedWebp, CURRENT_VARIANT_PROFILE_VERSION);
    expect(r.profileKnown).toBe(true);
    expect(r.thumbnail).toEqual({ ok: false, reason: "ANIMATED_INPUT_REJECTED" });
    expect(r.preview).toEqual({ ok: false, reason: "ANIMATED_INPUT_REJECTED" });
  });

  it("両 variant 失敗を表現できる（garbage 入力 → 両方 GENERATION_FAILED）", async () => {
    const garbage = Buffer.from("still not an image");
    const r = await generateVariants(garbage, CURRENT_VARIANT_PROFILE_VERSION);
    expect(r.profileKnown).toBe(true);
    expect(r.thumbnail).toEqual({ ok: false, reason: "GENERATION_FAILED" });
    expect(r.preview).toEqual({ ok: false, reason: "GENERATION_FAILED" });
  });

  it("failure result は固定 reason のみ（raw error を含まない）", async () => {
    const r = await generateVariants(Buffer.from("x"), CURRENT_VARIANT_PROFILE_VERSION);
    expect(Object.keys(r.thumbnail).sort()).toEqual(["ok", "reason"]);
    expect(Object.keys(r.preview).sort()).toEqual(["ok", "reason"]);
  });
});

describe("generateVariants — variant の独立性（sharp 隔離 mock）", () => {
  it("thumbnail(q85) だけが失敗しても preview(q90) の結果は失われない", async () => {
    vi.resetModules();
    vi.doMock("sharp", () => {
      // quality 85 の encode だけ失敗する最小 chainable mock
      const makePipeline = (failQuality: number) => {
        let currentQuality: number | null = null;
        const pipeline = {
          rotate: () => pipeline,
          resize: () => pipeline,
          webp: (opts?: { quality?: number }) => {
            currentQuality = opts?.quality ?? null;
            return pipeline;
          },
          metadata: async () => ({ width: 600, height: 400, pages: 1 }),
          toBuffer: async () => {
            if (currentQuality === failQuality) throw new Error("mocked thumbnail encoder failure");
            return { data: Buffer.from("mock-webp-bytes"), info: { width: 10, height: 7, format: "webp" } };
          },
        };
        return pipeline;
      };
      const sharpMock = () => makePipeline(85);
      return { default: sharpMock };
    });

    try {
      const { generateVariants: gen } = await import("./variantProfile");
      const { CURRENT_VARIANT_PROFILE_VERSION: ver } = await import("./uploadIntentCore");
      const r = await gen(Buffer.from("any"), ver);
      expect(r.profileKnown).toBe(true);
      expect(r.thumbnail).toEqual({ ok: false, reason: "GENERATION_FAILED" });
      expect(r.preview.ok).toBe(true); // preview は道連れにならない
    } finally {
      vi.doUnmock("sharp");
      vi.resetModules();
    }
  });
});
