import { describe, it, expect } from "vitest";
import { parseFinalizePayload, FINALIZE_ALLOWED_KEYS } from "./finalizePayload";

const VALID_ID = "cmintent0001abcdefghijklm";

describe("parseFinalizePayload — body 全体", () => {
  it("正常な {intentId} は pass する", () => {
    const r = parseFinalizePayload({ intentId: VALID_ID });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.intentId).toBe(VALID_ID);
  });

  it("許可キーは intentId の 1 件だけ", () => {
    expect(FINALIZE_ALLOWED_KEYS).toEqual(["intentId"]);
  });

  it("null / undefined / array / primitive は拒否", () => {
    for (const body of [null, undefined, [], [VALID_ID], "str", 42, true]) {
      expect(parseFinalizePayload(body).ok).toBe(false);
    }
  });

  it("intentId 欠落は拒否", () => {
    const r = parseFinalizePayload({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("intentId");
  });

  it("client が server-owned field を注入したら追加キーとして拒否（値を leak しない）", () => {
    for (const extra of [
      "workspaceId",
      "sessionId",
      "stagingOriginalPath",
      "canonicalOriginalPath",
      "bucket",
      "clientFileHash",
      "declaredSizeBytes",
      "declaredMimeType",
      "finalizeAttemptToken",
      "reservedSortOrder",
      "uploadItemId",
      "variantProfileVersion",
    ]) {
      const r = parseFinalizePayload({ intentId: VALID_ID, [extra]: "INJECTED_VALUE" });
      expect(r.ok, extra).toBe(false);
      if (!r.ok) {
        expect(r.message).not.toContain("INJECTED_VALUE");
        expect(r.message).not.toContain(extra);
      }
    }
  });
});

describe("parseFinalizePayload — intentId", () => {
  it("非 string は拒否", () => {
    for (const v of [1, null, {}, [], true]) {
      expect(parseFinalizePayload({ intentId: v }).ok).toBe(false);
    }
  });

  it("空・空白のみは拒否", () => {
    for (const v of ["", " ", "\t", "\n", "   "]) {
      expect(parseFinalizePayload({ intentId: v }).ok).toBe(false);
    }
  });

  it("前後空白は trim して受理する", () => {
    const r = parseFinalizePayload({ intentId: `  ${VALID_ID}  ` });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.intentId).toBe(VALID_ID);
  });

  it("unsafe / path-shaped な intentId は拒否", () => {
    for (const bad of [
      "a\u0000b", // NUL
      "a/b", // slash
      "a\\b", // backslash
      "..", // traversal
      "../a",
      "a..b/..",
      "a.b", // dot は cuid に現れない
      "a?b", // query
      "a#b", // fragment
      "a b", // 内部空白
      "a\nb",
      "%2e%2e",
      "a".repeat(129), // 長さ上限超過
    ]) {
      expect(parseFinalizePayload({ intentId: bad }).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("エラー message へ入力値を含めない", () => {
    const secret = "SECRET_INTENT/../etc";
    const r = parseFinalizePayload({ intentId: secret });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).not.toContain("SECRET_INTENT");
      expect(r.message).not.toContain("etc");
    }
  });
});
