import { describe, it, expect } from "vitest";
import {
  parsePreparePayload,
  isJsonContentType,
  ORIGINAL_NAME_MAX_LENGTH,
  PREPARE_ALLOWED_KEYS,
} from "./preparePayload";
import { MAX_ORIGINAL_BYTES } from "./uploadLimits";

const VALID = {
  sessionId: "cms0du3zsession",
  clientUploadId: "3f1a2b4c-5d6e-4f70-8a91-b2c3d4e5f607",
  originalName: "photo.jpg",
  declaredSizeBytes: 1024,
  declaredMimeType: "image/jpeg",
  clientFileHash: "a".repeat(64),
};

const okPayload = (over: Record<string, unknown> = {}) => ({ ...VALID, ...over });

describe("parsePreparePayload — body 全体", () => {
  it("正常な6フィールドはpassする", () => {
    const r = parsePreparePayload(okPayload());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.sessionId).toBe(VALID.sessionId);
  });

  it("null / array / primitive は拒否", () => {
    for (const body of [null, undefined, [], ["a"], "str", 42, true]) {
      const r = parsePreparePayload(body);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe("validation");
    }
  });

  it("許可6キー以外の追加キーは拒否(値をmessageへ含めない)", () => {
    for (const extra of [
      "workspaceId",
      "userId",
      "bucket",
      "stagingOriginalPath",
      "intentId",
      "uploadItemId",
      "reservedSortOrder",
      "tokenIssueDeadlineAt",
      "signedUrl",
      "upsert",
      "canonicalOriginalPath",
      "variantProfileVersion",
    ]) {
      const r = parsePreparePayload(okPayload({ [extra]: "x" }));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe("validation");
        expect(r.error.message).not.toContain("x");
      }
    }
  });

  it("必須フィールド欠落は拒否", () => {
    for (const key of PREPARE_ALLOWED_KEYS) {
      const body = okPayload();
      delete (body as Record<string, unknown>)[key];
      const r = parsePreparePayload(body);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toContain(key);
    }
  });
});

describe("parsePreparePayload — sessionId", () => {
  it("非string / 空 / 空白のみは拒否", () => {
    for (const v of [1, null, {}, "", "   "]) {
      expect(parsePreparePayload(okPayload({ sessionId: v })).ok).toBe(false);
    }
  });

  it("前後空白はtrimされる", () => {
    const r = parsePreparePayload(okPayload({ sessionId: "  abc  " }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.sessionId).toBe("abc");
  });
});

describe("parsePreparePayload — clientUploadId", () => {
  it("UUID形式のみ許可", () => {
    expect(parsePreparePayload(okPayload({ clientUploadId: VALID.clientUploadId })).ok).toBe(true);
    for (const v of ["not-a-uuid", "", "3f1a2b4c5d6e4f708a91b2c3d4e5f607", 12345, null]) {
      expect(parsePreparePayload(okPayload({ clientUploadId: v })).ok).toBe(false);
    }
  });
});

describe("parsePreparePayload — originalName", () => {
  it("1〜255文字を許可、256文字は拒否", () => {
    expect(parsePreparePayload(okPayload({ originalName: "a" })).ok).toBe(true);
    expect(parsePreparePayload(okPayload({ originalName: "a".repeat(ORIGINAL_NAME_MAX_LENGTH) })).ok).toBe(true);
    expect(parsePreparePayload(okPayload({ originalName: "a".repeat(ORIGINAL_NAME_MAX_LENGTH + 1) })).ok).toBe(false);
    expect(parsePreparePayload(okPayload({ originalName: "" })).ok).toBe(false);
  });

  it("trim後が空なら拒否", () => {
    expect(parsePreparePayload(okPayload({ originalName: "   " })).ok).toBe(false);
  });

  it("NUL文字を含む場合は拒否", () => {
    expect(parsePreparePayload(okPayload({ originalName: "a\u0000b.jpg" })).ok).toBe(false);
  });

  it("fingerprint用に受信文字列をそのまま保持する(trimしない)", () => {
    const r = parsePreparePayload(okPayload({ originalName: "  spaced.jpg  " }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.originalName).toBe("  spaced.jpg  ");
  });

  it("エラーmessageへ入力値を含めない", () => {
    const secret = "SECRET-FILENAME.jpg";
    const r = parsePreparePayload(okPayload({ originalName: secret + "\u0000" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).not.toContain("SECRET-FILENAME");
  });
});

describe("parsePreparePayload — declaredSizeBytes", () => {
  it("1以上・上限以下を許可", () => {
    expect(parsePreparePayload(okPayload({ declaredSizeBytes: 1 })).ok).toBe(true);
    expect(parsePreparePayload(okPayload({ declaredSizeBytes: MAX_ORIGINAL_BYTES })).ok).toBe(true);
  });

  it("0以下はvalidation error", () => {
    for (const v of [0, -1]) {
      const r = parsePreparePayload(okPayload({ declaredSizeBytes: v }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe("validation");
    }
  });

  it("上限超過は payload_too_large", () => {
    const r = parsePreparePayload(okPayload({ declaredSizeBytes: MAX_ORIGINAL_BYTES + 1 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("payload_too_large");
  });

  it("非整数 / 非数値 / 非safe integerは拒否", () => {
    for (const v of [1.5, "1024", null, NaN, Number.MAX_SAFE_INTEGER + 2]) {
      const r = parsePreparePayload(okPayload({ declaredSizeBytes: v }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe("validation");
    }
  });
});

describe("parsePreparePayload — declaredMimeType", () => {
  it("jpeg / png / webp のみ許可", () => {
    for (const m of ["image/jpeg", "image/png", "image/webp"]) {
      expect(parsePreparePayload(okPayload({ declaredMimeType: m })).ok).toBe(true);
    }
  });

  it("それ以外は unsupported_media_type", () => {
    for (const m of ["image/gif", "image/JPEG", "text/plain", "application/octet-stream", "image/jpeg; charset=utf-8", ""]) {
      const r = parsePreparePayload(okPayload({ declaredMimeType: m }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe("unsupported_media_type");
    }
  });

  it("形式不正はサイズ超過より優先される(415が先)", () => {
    const r = parsePreparePayload(okPayload({ declaredMimeType: "image/gif", declaredSizeBytes: MAX_ORIGINAL_BYTES + 1 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("unsupported_media_type");
  });
});

describe("parsePreparePayload — clientFileHash", () => {
  it("小文字hex 64文字のみ許可", () => {
    expect(parsePreparePayload(okPayload({ clientFileHash: "0123456789abcdef".repeat(4) })).ok).toBe(true);
  });

  it("uppercaseは自動変換せず拒否", () => {
    const r = parsePreparePayload(okPayload({ clientFileHash: "A".repeat(64) }));
    expect(r.ok).toBe(false);
  });

  it("長さ違い / 非hex / 非stringは拒否", () => {
    for (const v of ["a".repeat(63), "a".repeat(65), "g".repeat(64), "", null, 1]) {
      expect(parsePreparePayload(okPayload({ clientFileHash: v })).ok).toBe(false);
    }
  });

  it("エラーmessageへhash値を含めない", () => {
    const r = parsePreparePayload(okPayload({ clientFileHash: "b".repeat(65) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).not.toContain("bbb");
  });
});

describe("isJsonContentType", () => {
  it("JSON系を許可", () => {
    expect(isJsonContentType("application/json")).toBe(true);
    expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
    expect(isJsonContentType("application/merge-patch+json")).toBe(true);
    expect(isJsonContentType("APPLICATION/JSON")).toBe(true);
  });

  it("非JSON / 欠落を拒否", () => {
    for (const v of [null, "", "text/plain", "multipart/form-data", "application/x-www-form-urlencoded"]) {
      expect(isJsonContentType(v)).toBe(false);
    }
  });
});
