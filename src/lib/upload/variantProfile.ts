import "server-only";

// Phase 10-43-B3a: variant 生成プロファイルの正本定義と server-side 生成器。
//
// prepare は intent へ variantProfileVersion を焼き込み済みだが、その実体は
// これまで存在しなかった。この module が registry としての唯一の定義になる。
// deploy 世代をまたぐ retry でも同じ内容の variant を作るため、生成は必ず
// intent に固定された version の profile で行い、未知 version を現行 profile
// で代替生成しない（fail-closed）。
//
// 生成契約:
// - variant ごとに独立（thumbnail の失敗が preview を道連れにしない）
// - 失敗は固定 reason のみ（sharp の生 error / stack / 入力情報を返さない）
// - original buffer は変更しない（読み取り専用入力）
// - animated / multi-page 入力は measurement 段で拒否済みが前提だが、
//   この helper 単体でも「暗黙に先頭 frame を採用」しないよう明示拒否する

import sharp from "sharp";
import { CURRENT_VARIANT_PROFILE_VERSION } from "./uploadIntentCore";
import { MAX_IMAGE_PIXELS } from "./finalizeMeasurement";

export type VariantSpec = {
  // 長辺の最大値。fit: "inside" + withoutEnlargement で「縮小のみ」。
  maxEdge: number;
  // sharp の WebP quality（1–100）。client canvas の 0.85 / 0.90 に対応する。
  quality: number;
};

export type VariantProfile = {
  thumbnail: VariantSpec;
  preview: VariantSpec;
};

// 正本 registry。version 文字列は uploadIntentCore の定数を唯一の出所とする。
const VARIANT_PROFILES: Record<string, VariantProfile> = {
  [CURRENT_VARIANT_PROFILE_VERSION]: {
    thumbnail: { maxEdge: 300, quality: 85 },
    preview: { maxEdge: 800, quality: 90 },
  },
};

export function getVariantProfile(version: string): VariantProfile | null {
  // own-property のみを有効な profile として認める。plain object の registry は
  // prototype chain を持つため、"toString" / "constructor" 等の値を単純な
  // index access や `in` 演算子で参照すると Object.prototype 由来の関数が
  // 返ってしまい、unknown version が誤って「既知」扱いになる（fail-closed
  // 契約違反）。hasOwnProperty で own-property であることを明示的に確認する。
  if (!Object.prototype.hasOwnProperty.call(VARIANT_PROFILES, version)) {
    return null;
  }
  return VARIANT_PROFILES[version];
}

export type VariantFailureReason =
  | "UNKNOWN_PROFILE"
  | "ANIMATED_INPUT_REJECTED"
  | "GENERATION_FAILED";

export type VariantOutcome =
  | { ok: true; buffer: Buffer; mimeType: "image/webp"; width: number; height: number }
  | { ok: false; reason: VariantFailureReason };

export type VariantSetResult = {
  profileKnown: boolean;
  thumbnail: VariantOutcome;
  preview: VariantOutcome;
};

async function generateOneVariant(input: Buffer, spec: VariantSpec): Promise<VariantOutcome> {
  try {
    const { data, info } = await sharp(input, { limitInputPixels: MAX_IMAGE_PIXELS })
      .rotate() // EXIF auto orientation を variant へ焼き込む
      .resize(spec.maxEdge, spec.maxEdge, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: spec.quality })
      .toBuffer({ resolveWithObject: true });

    if (info.width < 1 || info.height < 1) {
      return { ok: false, reason: "GENERATION_FAILED" };
    }
    return { ok: true, buffer: data, mimeType: "image/webp", width: info.width, height: info.height };
  } catch {
    return { ok: false, reason: "GENERATION_FAILED" };
  }
}

/**
 * intent に固定された profileVersion に従って thumbnail / preview を生成する。
 * - 未知 version: sharp 処理を一切開始せず両方 UNKNOWN_PROFILE（nonfatal —
 *   B3b では両 variant を null として UploadItem READY を許可する契約）
 * - animated / multi-page: 生成前に明示拒否（先頭 frame の暗黙採用をしない）
 * - 各 variant は独立に成功/失敗し得る
 */
export async function generateVariants(input: Buffer, profileVersion: string): Promise<VariantSetResult> {
  const profile = getVariantProfile(profileVersion);
  if (!profile) {
    return {
      profileKnown: false,
      thumbnail: { ok: false, reason: "UNKNOWN_PROFILE" },
      preview: { ok: false, reason: "UNKNOWN_PROFILE" },
    };
  }

  // defence-in-depth: measurement を経ずに呼ばれても animated を静止画化しない。
  try {
    const meta = await sharp(input, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
    if (typeof meta.pages === "number" && meta.pages > 1) {
      return {
        profileKnown: true,
        thumbnail: { ok: false, reason: "ANIMATED_INPUT_REJECTED" },
        preview: { ok: false, reason: "ANIMATED_INPUT_REJECTED" },
      };
    }
  } catch {
    return {
      profileKnown: true,
      thumbnail: { ok: false, reason: "GENERATION_FAILED" },
      preview: { ok: false, reason: "GENERATION_FAILED" },
    };
  }

  const [thumbnail, preview] = await Promise.all([
    generateOneVariant(input, profile.thumbnail),
    generateOneVariant(input, profile.preview),
  ]);
  return { profileKnown: true, thumbnail, preview };
}
