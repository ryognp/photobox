import "server-only";

// Phase 10-43-B3a: finalize の実測検証 core。
//
// staging object の bytes と、prepare 時に intent へ焼き込んだ immutable な
// 申告値（declaredSizeBytes / declaredMimeType / clientFileHash）を照合し、
// server-measured な確定値を返す。DB / Storage I/O は行わない（bytes は
// 呼び出し側=B3b route が download 済みのものを渡す）。
//
// 重要な契約:
// - client 申告の width / height は一切受け取らない（sharp 実測のみ）
// - 拡張子は filename ではなく measured MIME から決める
// - provider Content-Type を正本にしない（magic bytes が正本）
// - hash は小文字 hex 同士の厳密比較（uppercase を暗黙救済しない）
// - 違反は throw ではなく固定 reason の domain result で返す
//   （sharp の生 message / stack / 入力値は result に含めない）
// - animated / multi-page 入力は形式を問わず拒否（先頭 frame の暗黙採用禁止）

import sharp, { type Metadata } from "sharp";
import { MAX_ORIGINAL_BYTES } from "./uploadLimits";
import { sha256Hex } from "./hashServer";
import { detectImageMime, imageExtForMime, type AllowedMime, type ImageExt } from "./validateImage";

// Production 固定の pixel 上限（8192 × 8192 = 64MP 相当）。
// test はこの定数を書き換えるのではなく、test 専用 entry point で
// 小さい上限を注入して境界を検証する（実 64MP 画像は生成しない）。
export const MAX_IMAGE_PIXELS = 67_108_864;

export type FinalizeMeasurementFailureReason =
  | "EMPTY_OBJECT"
  | "PAYLOAD_TOO_LARGE"
  | "DECLARED_SIZE_MISMATCH"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "MIME_MISMATCH"
  | "FILE_HASH_MISMATCH"
  | "INVALID_IMAGE"
  | "IMAGE_TOO_LARGE_PIXELS"
  | "ANIMATED_IMAGE_UNSUPPORTED";

export type MeasuredImage = {
  actualSizeBytes: number;
  actualMimeType: AllowedMime;
  actualExt: ImageExt;
  actualFileHash: string;
  // EXIF orientation 適用後（= 表示時）の寸法。
  widthPx: number;
  heightPx: number;
  pixelCount: number;
};

export type FinalizeMeasurementResult =
  | { ok: true; measured: MeasuredImage }
  | { ok: false; reason: FinalizeMeasurementFailureReason };

export type StagedIntentHints = {
  declaredSizeBytes: number;
  declaredMimeType: string;
  clientFileHash: string;
};

const fail = (reason: FinalizeMeasurementFailureReason): FinalizeMeasurementResult => ({
  ok: false,
  reason,
});

// EXIF orientation 5–8 は 90°系の回転を含むため、表示寸法は
// 幅と高さが入れ替わる。metadata() の width / height は「加工前の
// 符号化寸法」であり、`.rotate()` を pipeline に置いても metadata が
// 加工後寸法を返すわけではない — swap はここで明示的に行う。
const SWAPPED_ORIENTATIONS = new Set([5, 6, 7, 8]);

function orientedDimensions(width: number, height: number, orientation: number | undefined) {
  if (orientation !== undefined && SWAPPED_ORIENTATIONS.has(orientation)) {
    return { widthPx: height, heightPx: width };
  }
  return { widthPx: width, heightPx: height };
}

async function measureWithMaxPixels(
  bytes: Uint8Array,
  hints: StagedIntentHints,
  maxPixels: number,
): Promise<FinalizeMeasurementResult> {
  // ---- サイズ（bytes） ----------------------------------------------------
  if (bytes.length === 0) return fail("EMPTY_OBJECT");
  if (bytes.length > MAX_ORIGINAL_BYTES) return fail("PAYLOAD_TOO_LARGE");
  if (bytes.length !== hints.declaredSizeBytes) return fail("DECLARED_SIZE_MISMATCH");

  // ---- MIME（magic bytes が正本） -----------------------------------------
  const detected = detectImageMime(bytes);
  if (!detected) return fail("UNSUPPORTED_MEDIA_TYPE");
  if (detected !== hints.declaredMimeType) return fail("MIME_MISMATCH");

  // ---- hash（小文字 hex 厳密一致・case folding なし） ----------------------
  const actualFileHash = sha256Hex(bytes);
  if (actualFileHash !== hints.clientFileHash) return fail("FILE_HASH_MISMATCH");

  // ---- decode（header 解析 → 上限判定 → 全 decode 検証の順） ---------------
  // Provider default limit must not preempt the domain's 67,108,864-pixel
  // classification. metadata() は header 解析専用として呼ぶため、sharp 既定の
  // pixel limit（≈268MP）をここで無効化する（limitInputPixels: false）。
  // これを外側の防壁として metadata 段に残すと、「67,108,864 超・sharp 既定以下」
  // は domain 判定で IMAGE_TOO_LARGE_PIXELS に分類できる一方、「sharp 既定超」は
  // metadata() 自体が例外を投げて一律 INVALID_IMAGE に化けてしまい、実測 pixel 数
  // に関わらず一貫した IMAGE_TOO_LARGE_PIXELS 分類という契約が破れる。
  // full decode（下の stats()）側は注入された maxPixels をそのまま維持する
  // （そちらは domain 上限判定を通過した入力にのみ到達するため防壁として機能する）。
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: false }).metadata();
  } catch {
    return fail("INVALID_IMAGE");
  }

  const width = meta.width;
  const height = meta.height;
  if (
    typeof width !== "number" || typeof height !== "number" ||
    !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
    width < 1 || height < 1
  ) {
    return fail("INVALID_IMAGE");
  }

  // multi-page / multi-frame（animated WebP 等）は形式を問わず拒否。
  if (typeof meta.pages === "number" && meta.pages > 1) {
    return fail("ANIMATED_IMAGE_UNSUPPORTED");
  }

  const pixelCount = width * height;
  if (pixelCount > maxPixels) return fail("IMAGE_TOO_LARGE_PIXELS");

  // header が正しくても本体が壊れている入力を弾くため、全 decode を実施する
  // （stats() は全画素の統計計算 = 完全 decode）。
  try {
    await sharp(input, { limitInputPixels: maxPixels }).stats();
  } catch {
    return fail("INVALID_IMAGE");
  }

  const { widthPx, heightPx } = orientedDimensions(width, height, meta.orientation);

  return {
    ok: true,
    measured: {
      actualSizeBytes: bytes.length,
      actualMimeType: detected,
      actualExt: imageExtForMime(detected),
      actualFileHash,
      widthPx,
      heightPx,
      pixelCount,
    },
  };
}

/** Production 用 entry point。pixel 上限は常に MAX_IMAGE_PIXELS 固定。 */
export function measureStagedImage(
  bytes: Uint8Array,
  hints: StagedIntentHints,
): Promise<FinalizeMeasurementResult> {
  return measureWithMaxPixels(bytes, hints, MAX_IMAGE_PIXELS);
}

/**
 * TEST 専用 entry point — pixel 上限の境界を小さい画像で検証するための注入口。
 * Production route から呼んではならない（名前で誤用を防ぐ。B3b レビューで
 * importer を監査する）。
 */
export function measureStagedImageWithMaxPixelsForTest(
  bytes: Uint8Array,
  hints: StagedIntentHints,
  maxPixels: number,
): Promise<FinalizeMeasurementResult> {
  return measureWithMaxPixels(bytes, hints, maxPixels);
}
