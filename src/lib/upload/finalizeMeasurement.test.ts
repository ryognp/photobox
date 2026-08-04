// Phase 10-43-B3a: finalize 実測検証 core の unit test。
// binary fixture は repository へ追加せず、画像バイトは test 実行時に sharp で
// 生成する。64MP の実画像は生成しない — pixel 境界は test 専用 entry point の
// 上限注入（measureStagedImageWithMaxPixelsForTest）で小さい画像により検証する。

import { describe, it, expect, beforeAll, vi } from "vitest";
import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  measureStagedImage,
  measureStagedImageWithMaxPixelsForTest,
  MAX_IMAGE_PIXELS,
  type StagedIntentHints,
} from "./finalizeMeasurement";
import { MAX_ORIGINAL_BYTES } from "./uploadLimits";

function hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hintsFor(bytes: Uint8Array, mime: string, over: Partial<StagedIntentHints> = {}): StagedIntentHints {
  return {
    declaredSizeBytes: bytes.length,
    declaredMimeType: mime,
    clientFileHash: hex(bytes),
    ...over,
  };
}

let jpeg40x20: Buffer; // landscape
let png10x10: Buffer;
let webp16x8: Buffer;
let jpegOriented6: Buffer; // 40x20 coded + EXIF orientation 6（90°回転 → 表示 20x40）
let animatedWebp: Buffer;

beforeAll(async () => {
  jpeg40x20 = await sharp({ create: { width: 40, height: 20, channels: 3, background: { r: 10, g: 200, b: 30 } } })
    .jpeg()
    .toBuffer();
  png10x10 = await sharp({ create: { width: 10, height: 10, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 0.5 } } })
    .png()
    .toBuffer();
  webp16x8 = await sharp({ create: { width: 16, height: 8, channels: 3, background: { r: 250, g: 250, b: 0 } } })
    .webp()
    .toBuffer();
  jpegOriented6 = await sharp({ create: { width: 40, height: 20, channels: 3, background: { r: 90, g: 90, b: 90 } } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();

  const frameA = await sharp({ create: { width: 12, height: 12, channels: 3, background: { r: 255, g: 0, b: 0 } } })
    .webp()
    .toBuffer();
  const frameB = await sharp({ create: { width: 12, height: 12, channels: 3, background: { r: 0, g: 0, b: 255 } } })
    .webp()
    .toBuffer();
  animatedWebp = await sharp([frameA, frameB], { join: { animated: true } })
    .webp()
    .toBuffer();
});

describe("measureStagedImage — 正常系", () => {
  it("valid JPEG: server実測の size / mime / ext / hash / 寸法を返す", async () => {
    const r = await measureStagedImage(jpeg40x20, hintsFor(jpeg40x20, "image/jpeg"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.measured.actualSizeBytes).toBe(jpeg40x20.length);
      expect(r.measured.actualMimeType).toBe("image/jpeg");
      expect(r.measured.actualExt).toBe("jpg");
      expect(r.measured.actualFileHash).toBe(hex(jpeg40x20)); // server計算値
      expect(r.measured.widthPx).toBe(40);
      expect(r.measured.heightPx).toBe(20);
      expect(r.measured.pixelCount).toBe(800);
    }
  });

  it("valid PNG（alpha付き）", async () => {
    const r = await measureStagedImage(png10x10, hintsFor(png10x10, "image/png"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.measured.actualMimeType).toBe("image/png");
      expect(r.measured.actualExt).toBe("png");
      expect(r.measured.widthPx).toBe(10);
      expect(r.measured.heightPx).toBe(10);
    }
  });

  it("valid WebP", async () => {
    const r = await measureStagedImage(webp16x8, hintsFor(webp16x8, "image/webp"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.measured.actualMimeType).toBe("image/webp");
      expect(r.measured.actualExt).toBe("webp");
      expect(r.measured.widthPx).toBe(16);
      expect(r.measured.heightPx).toBe(8);
    }
  });
});

describe("measureStagedImage — サイズ検証", () => {
  it("zero byte は EMPTY_OBJECT", async () => {
    const empty = Buffer.alloc(0);
    const r = await measureStagedImage(empty, hintsFor(empty, "image/jpeg", { declaredSizeBytes: 0 }));
    expect(r).toEqual({ ok: false, reason: "EMPTY_OBJECT" });
  });

  it("MAX_ORIGINAL_BYTES 超過は PAYLOAD_TOO_LARGE（declared一致でも拒否）", async () => {
    const oversize = Buffer.alloc(MAX_ORIGINAL_BYTES + 1);
    const r = await measureStagedImage(oversize, hintsFor(oversize, "image/jpeg"));
    expect(r).toEqual({ ok: false, reason: "PAYLOAD_TOO_LARGE" });
  });

  it("declaredSizeBytes と実 bytes の不一致は DECLARED_SIZE_MISMATCH", async () => {
    const r = await measureStagedImage(
      jpeg40x20,
      hintsFor(jpeg40x20, "image/jpeg", { declaredSizeBytes: jpeg40x20.length + 1 }),
    );
    expect(r).toEqual({ ok: false, reason: "DECLARED_SIZE_MISMATCH" });
  });
});

describe("measureStagedImage — MIME / hash 検証", () => {
  it("非対応バイト列は UNSUPPORTED_MEDIA_TYPE", async () => {
    const junk = Buffer.from("this is definitely not an image body at all");
    const r = await measureStagedImage(junk, hintsFor(junk, "image/jpeg"));
    expect(r).toEqual({ ok: false, reason: "UNSUPPORTED_MEDIA_TYPE" });
  });

  it("magic bytes と declaredMimeType の不一致は MIME_MISMATCH", async () => {
    const r = await measureStagedImage(jpeg40x20, hintsFor(jpeg40x20, "image/png"));
    expect(r).toEqual({ ok: false, reason: "MIME_MISMATCH" });
  });

  it("hash 不一致は FILE_HASH_MISMATCH", async () => {
    const r = await measureStagedImage(
      jpeg40x20,
      hintsFor(jpeg40x20, "image/jpeg", { clientFileHash: "a".repeat(64) }),
    );
    expect(r).toEqual({ ok: false, reason: "FILE_HASH_MISMATCH" });
  });

  it("uppercase hash を暗黙救済しない（case folding なし）", async () => {
    const r = await measureStagedImage(
      jpeg40x20,
      hintsFor(jpeg40x20, "image/jpeg", { clientFileHash: hex(jpeg40x20).toUpperCase() }),
    );
    expect(r).toEqual({ ok: false, reason: "FILE_HASH_MISMATCH" });
  });
});

describe("measureStagedImage — decode / 構造検証", () => {
  it("header が正しく本体が壊れた画像は INVALID_IMAGE", async () => {
    // 有効な JPEG の先頭だけ残して本体を破壊する（magic bytes は通る）。
    const corrupt = Buffer.concat([jpeg40x20.subarray(0, 24), Buffer.alloc(64, 0xab)]);
    const r = await measureStagedImage(corrupt, hintsFor(corrupt, "image/jpeg"));
    expect(r).toEqual({ ok: false, reason: "INVALID_IMAGE" });
  });

  it("animated / multi-page WebP は ANIMATED_IMAGE_UNSUPPORTED", async () => {
    const r = await measureStagedImage(animatedWebp, hintsFor(animatedWebp, "image/webp"));
    expect(r).toEqual({ ok: false, reason: "ANIMATED_IMAGE_UNSUPPORTED" });
  });

  it("failure result は固定 reason のみ（raw error / filename / provider 情報を含まない）", async () => {
    const junk = Buffer.from("not an image");
    const r = await measureStagedImage(junk, hintsFor(junk, "image/jpeg"));
    expect(r.ok).toBe(false);
    expect(Object.keys(r).sort()).toEqual(["ok", "reason"]);
  });
});

describe("measureStagedImage — orientation", () => {
  it("orientation 指定なし（=1相当）は符号化寸法のまま", async () => {
    const r = await measureStagedImage(jpeg40x20, hintsFor(jpeg40x20, "image/jpeg"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.measured.widthPx).toBe(40);
      expect(r.measured.heightPx).toBe(20);
    }
  });

  it("orientation 6 は width / height を swap（表示寸法を正本にする）", async () => {
    const r = await measureStagedImage(jpegOriented6, hintsFor(jpegOriented6, "image/jpeg"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.measured.widthPx).toBe(20);
      expect(r.measured.heightPx).toBe(40);
      expect(r.measured.pixelCount).toBe(800); // 画素数は不変
    }
  });
});

describe("measureStagedImage — pixel 上限", () => {
  it("Production 定数は 67,108,864（8192×8192）で固定", () => {
    expect(MAX_IMAGE_PIXELS).toBe(67_108_864);
    expect(MAX_IMAGE_PIXELS).toBe(8192 * 8192);
  });

  it("境界ちょうど（pixelCount == 上限）は許可", async () => {
    // 10×10=100px の実画像に上限 100 を注入
    const r = await measureStagedImageWithMaxPixelsForTest(png10x10, hintsFor(png10x10, "image/png"), 100);
    expect(r.ok).toBe(true);
  });

  it("上限 +1px 側（pixelCount > 上限）は IMAGE_TOO_LARGE_PIXELS", async () => {
    const r = await measureStagedImageWithMaxPixelsForTest(png10x10, hintsFor(png10x10, "image/png"), 99);
    expect(r).toEqual({ ok: false, reason: "IMAGE_TOO_LARGE_PIXELS" });
  });

  it("上限超過は decode 系エラーではなく専用 reason で分類される", async () => {
    const r = await measureStagedImageWithMaxPixelsForTest(jpeg40x20, hintsFor(jpeg40x20, "image/jpeg"), 799);
    expect(r).toEqual({ ok: false, reason: "IMAGE_TOO_LARGE_PIXELS" });
  });

  // Provider default limit must not preempt the domain's 67,108,864-pixel
  // classification. sharp 既定の pixel limit（≈268MP）を超える画像でも、
  // domain 上限（この test では小さい注入値）超過は一貫して
  // IMAGE_TOO_LARGE_PIXELS に分類され、一般 INVALID_IMAGE へ化けない。
  // 実際に巨大画像を生成せず、sharp を module-isolated mock して
  // metadata() だけが「sharp 既定 limit 超」相当の巨大寸法を返すケースを再現する。
  it("sharp既定limit超の巨大画像でも IMAGE_TOO_LARGE_PIXELS（INVALID_IMAGEへ化けない）・full decodeへ到達しない", async () => {
    vi.resetModules();
    const metadataCalls: unknown[] = [];
    const statsCalls: unknown[] = [];
    vi.doMock("sharp", () => ({
      default: (_input: unknown, opts?: unknown) => ({
        metadata: async () => {
          metadataCalls.push(opts);
          // sharp 既定 limit（0x3FFF ** 2 = 268,435,441）を超える寸法。
          // 素の sharp なら limitInputPixels が既定のままだと metadata() 自体が
          // throw する規模。ここでは header 解析専用として成功させ、実際の
          // sharp が limitInputPixels:false でこの header を返すことを模擬する。
          return { width: 20_000, height: 20_000, pages: 1, orientation: undefined };
        },
        stats: async () => {
          statsCalls.push(opts);
          return {};
        },
      }),
    }));
    try {
      const { measureStagedImage: measure } = await import("./finalizeMeasurement");
      const fakeBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(13)]);
      const hints = {
        declaredSizeBytes: fakeBytes.length,
        declaredMimeType: "image/jpeg",
        clientFileHash: createHash("sha256").update(fakeBytes).digest("hex"),
      };
      const r = await measure(fakeBytes, hints);

      expect(r).toEqual({ ok: false, reason: "IMAGE_TOO_LARGE_PIXELS" });
      expect(metadataCalls.length).toBe(1);
      // metadata 呼び出しには limitInputPixels:false が渡っている
      expect(metadataCalls[0]).toEqual({ limitInputPixels: false });
      // pixel 上限超過は full decode（stats）へ到達する前に確定する
      expect(statsCalls.length).toBe(0);
    } finally {
      vi.doUnmock("sharp");
      vi.resetModules();
    }
  });
});
