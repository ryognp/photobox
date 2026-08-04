import { describe, it, expect } from "vitest";
import {
  intentStagingOriginalPath,
  isSafePathSegment,
  tempOriginalPath,
  tempThumbnailPath,
  tempPreviewPath,
} from "./storagePaths";

const WS = "cmws0000workspace";
const SESSION = "cmss0000session";
const INTENT = "cmin0000intent";

// path traversal / separator / control-char を持ち込む代表的な形。
const UNSAFE_SEGMENTS = [
  "..",
  "../..",
  "a/b",
  "a\\b",
  "a b",
  "a\u0000b",
  "a\nb",
  "",
  ".",
  "a.b", // ドットを含む id は staging 契約では許可しない(拡張子なし path のため)
  "a?b",
  "a#b",
  "%2e%2e",
  " leading",
  "trailing ",
];

describe("intentStagingOriginalPath — 正常形", () => {
  it("専用 staging namespace・拡張子なしの path を返す", () => {
    expect(intentStagingOriginalPath(WS, SESSION, INTENT)).toBe(
      `${WS}/upload-intents/${SESSION}/${INTENT}/original`,
    );
  });

  it("canonical temp namespace (uploads/) とは別空間である", () => {
    const staging = intentStagingOriginalPath(WS, SESSION, INTENT);
    expect(staging).toContain("/upload-intents/");
    expect(staging).not.toContain("/uploads/");
    // canonical 側は従来どおり uploads/ を使い、両者が衝突しないこと
    expect(tempOriginalPath(WS, SESSION, INTENT, "jpg")).toContain("/uploads/");
  });

  it("拡張子を含めない(finalize が実測するまで MIME を信頼しない)", () => {
    const staging = intentStagingOriginalPath(WS, SESSION, INTENT);
    expect(staging.endsWith("/original")).toBe(true);
    expect(staging).not.toMatch(/\.(jpg|jpeg|png|webp|bin)$/);
  });

  it("client 由来値 (originalName / clientUploadId) を含む余地がない", () => {
    // 引数は 3 つだけ = originalName や clientUploadId を渡す経路がない
    expect(intentStagingOriginalPath.length).toBe(3);
  });

  it("同一 intent なら常に同じ path(再発行で staging が変わらない)", () => {
    expect(intentStagingOriginalPath(WS, SESSION, INTENT)).toBe(intentStagingOriginalPath(WS, SESSION, INTENT));
  });

  it("intentId が違えば path も違う", () => {
    expect(intentStagingOriginalPath(WS, SESSION, "intentA")).not.toBe(
      intentStagingOriginalPath(WS, SESSION, "intentB"),
    );
  });
});

describe("intentStagingOriginalPath — containment guard", () => {
  it("workspaceId に unsafe segment があれば throw", () => {
    for (const bad of UNSAFE_SEGMENTS) {
      expect(() => intentStagingOriginalPath(bad, SESSION, INTENT)).toThrow(/Unsafe storage path segment/);
    }
  });

  it("sessionId に unsafe segment があれば throw", () => {
    for (const bad of UNSAFE_SEGMENTS) {
      expect(() => intentStagingOriginalPath(WS, bad, INTENT)).toThrow(/Unsafe storage path segment/);
    }
  });

  it("intentId に unsafe segment があれば throw", () => {
    for (const bad of UNSAFE_SEGMENTS) {
      expect(() => intentStagingOriginalPath(WS, SESSION, bad)).toThrow(/Unsafe storage path segment/);
    }
  });

  it("throw する error message へ攻撃者制御値を含めない", () => {
    const attacker = "../../etc/passwd";
    try {
      intentStagingOriginalPath(WS, SESSION, attacker);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).not.toContain("etc");
      expect((e as Error).message).not.toContain("..");
    }
  });

  it("生成された path は必ず workspaceId prefix 配下に収まる", () => {
    const staging = intentStagingOriginalPath(WS, SESSION, INTENT);
    expect(staging.startsWith(`${WS}/`)).toBe(true);
    expect(staging.split("/")).toHaveLength(5); // ws / upload-intents / session / intent / original
    expect(staging).not.toContain("//");
    expect(staging).not.toContain("..");
  });
});

describe("isSafePathSegment", () => {
  it("cuid / uuid 形状を許可", () => {
    for (const ok of ["cms0du3z0000abcd", "3f1a2b4c-5d6e-4f70-8a91-b2c3d4e5f607", "abc_DEF-123"]) {
      expect(isSafePathSegment(ok)).toBe(true);
    }
  });

  it("separator / traversal / 制御文字 / 空を拒否", () => {
    for (const bad of UNSAFE_SEGMENTS) {
      expect(isSafePathSegment(bad)).toBe(false);
    }
  });
});

describe("既存 temp path helper は不変(回帰確認)", () => {
  it("original / thumbnail / preview の形式が変わっていない", () => {
    expect(tempOriginalPath(WS, SESSION, INTENT, "jpg")).toBe(`${WS}/uploads/${SESSION}/${INTENT}/original.jpg`);
    expect(tempThumbnailPath(WS, SESSION, INTENT)).toBe(`${WS}/uploads/${SESSION}/${INTENT}/thumbnail.webp`);
    expect(tempPreviewPath(WS, SESSION, INTENT)).toBe(`${WS}/uploads/${SESSION}/${INTENT}/preview.webp`);
  });
});
