import { describe, it, expect } from "vitest";
import { normalizeStorageError, type NormalizedStorageError } from "./storageErrors";

// StorageApiError 互換の形状（installed 2.108.2 実体: status:number + statusCode:string
// が constructor で own property として設定される）。provider class は import しない。
function apiError(status: number, statusCode: string, message = "provider message"): unknown {
  const e = new Error(message) as Error & { status: number; statusCode: string };
  e.status = status;
  e.statusCode = statusCode;
  return e;
}

const SECRET = "SECRET_PROVIDER_DETAIL https://internal.example/bucket/path?token=tok_abc123";

function expectOnlyCodeAndRetryable(r: NormalizedStorageError) {
  expect(Object.keys(r).sort()).toEqual(["code", "retryable"]);
}

describe("normalizeStorageError — normalization table（status 主判定）", () => {
  it.each([
    [404, "404", "STORAGE_OBJECT_NOT_FOUND", false],
    [409, "409", "STORAGE_OBJECT_ALREADY_EXISTS", false],
    [401, "401", "STORAGE_UNAUTHORIZED", false],
    [403, "403", "STORAGE_UNAUTHORIZED", false],
    [429, "429", "STORAGE_RATE_LIMITED", true],
    [500, "500", "STORAGE_UNKNOWN", true],
    [502, "502", "STORAGE_UNKNOWN", true],
    [503, "503", "STORAGE_UNKNOWN", true],
  ] as const)("status %i / statusCode %s → %s (retryable=%s)", (status, statusCode, code, retryable) => {
    const r = normalizeStorageError(apiError(status, statusCode));
    expect(r).toEqual({ code, retryable });
  });

  it("400 は status 単独では分類せず UNKNOWN(retryable) — 意図的な非分類", () => {
    expect(normalizeStorageError(apiError(400, "400"))).toEqual({
      code: "STORAGE_UNKNOWN",
      retryable: true,
    });
  });

  // status 単独入力 — statusCode 側の一致で偽 PASS しないよう、numeric status
  // 判定の削除 mutation を単独で検出する。
  it.each([
    [404, "STORAGE_OBJECT_NOT_FOUND", false],
    [409, "STORAGE_OBJECT_ALREADY_EXISTS", false],
    [401, "STORAGE_UNAUTHORIZED", false],
    [403, "STORAGE_UNAUTHORIZED", false],
    [429, "STORAGE_RATE_LIMITED", true],
    [500, "STORAGE_UNKNOWN", true],
  ] as const)("status %i 単独（statusCode なし）→ %s", (status, code, retryable) => {
    expect(normalizeStorageError({ status })).toEqual({ code, retryable });
  });
});

describe("normalizeStorageError — statusCode 補助判定（status が分類不能な場合のみ）", () => {
  it("legacy 形状: status 400 + statusCode \"404\" → NOT_FOUND（旧 Supabase の missing object 形状）", () => {
    expect(normalizeStorageError(apiError(400, "404")).code).toBe("STORAGE_OBJECT_NOT_FOUND");
  });

  it("status なし + numeric-string statusCode で分類できる", () => {
    expect(normalizeStorageError({ statusCode: "409" }).code).toBe("STORAGE_OBJECT_ALREADY_EXISTS");
    expect(normalizeStorageError({ statusCode: "404" }).code).toBe("STORAGE_OBJECT_NOT_FOUND");
    expect(normalizeStorageError({ statusCode: "429" }).code).toBe("STORAGE_RATE_LIMITED");
  });

  it("symbolic statusCode（server 実装依存の表記ゆれ）を許容する", () => {
    expect(normalizeStorageError({ statusCode: "NoSuchKey" }).code).toBe("STORAGE_OBJECT_NOT_FOUND");
    expect(normalizeStorageError({ statusCode: "not_found" }).code).toBe("STORAGE_OBJECT_NOT_FOUND");
    expect(normalizeStorageError({ statusCode: "Duplicate" }).code).toBe("STORAGE_OBJECT_ALREADY_EXISTS");
    expect(normalizeStorageError({ statusCode: "AccessDenied" }).code).toBe("STORAGE_UNAUTHORIZED");
  });

  it("未知の provider code は UNKNOWN(retryable) へ安全に落ちる", () => {
    expect(normalizeStorageError({ statusCode: "WeirdProviderCode123" })).toEqual({
      code: "STORAGE_UNKNOWN",
      retryable: true,
    });
  });
});

describe("normalizeStorageError — status / statusCode 矛盾時は status 優先", () => {
  it("status 409 + statusCode \"500\" → ALREADY_EXISTS（status が分類可能なら勝つ）", () => {
    expect(normalizeStorageError(apiError(409, "500")).code).toBe("STORAGE_OBJECT_ALREADY_EXISTS");
  });

  it("status 500 + statusCode \"409\" → UNKNOWN(retryable)（5xx 分類が statusCode に先行）", () => {
    expect(normalizeStorageError(apiError(500, "409"))).toEqual({
      code: "STORAGE_UNKNOWN",
      retryable: true,
    });
  });

  it("status 404 + statusCode \"409\" → NOT_FOUND", () => {
    expect(normalizeStorageError(apiError(404, "409")).code).toBe("STORAGE_OBJECT_NOT_FOUND");
  });
});

describe("normalizeStorageError — network / Abort / timeout", () => {
  it("AbortError 相当は UNKNOWN(retryable)", () => {
    const e = new Error("The operation was aborted");
    e.name = "AbortError";
    expect(normalizeStorageError(e)).toEqual({ code: "STORAGE_UNKNOWN", retryable: true });
  });

  it("TimeoutError 相当は UNKNOWN(retryable)", () => {
    const e = new Error("timed out");
    e.name = "TimeoutError";
    expect(normalizeStorageError(e)).toEqual({ code: "STORAGE_UNKNOWN", retryable: true });
  });

  it("StorageUnknownError 相当（status/statusCode とも undefined）は UNKNOWN(retryable)", () => {
    // network / DNS 失敗は storage-js が StorageUnknownError に包み、
    // status / statusCode を持たない。
    const e = new Error("fetch failed") as Error & { originalError: unknown };
    e.originalError = new TypeError("fetch failed");
    expect(normalizeStorageError(e)).toEqual({ code: "STORAGE_UNKNOWN", retryable: true });
  });
});

describe("normalizeStorageError — defensive inputs（throw しない）", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["number", 42],
    ["string", "boom"],
    ["boolean", true],
    ["plain Error", new Error("plain")],
    ["TypeError", new TypeError("type")],
    ["empty object", {}],
    ["array", [1, 2, 3]],
  ])("%s → UNKNOWN(retryable)・throw しない", (_label, input) => {
    expect(normalizeStorageError(input)).toEqual({ code: "STORAGE_UNKNOWN", retryable: true });
  });

  it("getter が throw する object でも throw しない", () => {
    const evil = {};
    Object.defineProperty(evil, "status", {
      enumerable: true,
      get() {
        throw new Error("evil status getter");
      },
    });
    Object.defineProperty(evil, "statusCode", {
      enumerable: true,
      get() {
        throw new Error("evil statusCode getter");
      },
    });
    expect(normalizeStorageError(evil)).toEqual({ code: "STORAGE_UNKNOWN", retryable: true });
  });

  it("prototype 由来の status / statusCode を誤信頼しない（own property のみ）", () => {
    const proto = { status: 404, statusCode: "404" };
    const child = Object.create(proto) as object;
    // 継承 field は provider の実 instance shape（own property）と異なる → UNKNOWN
    expect(normalizeStorageError(child)).toEqual({ code: "STORAGE_UNKNOWN", retryable: true });
  });

  it("status が非整数 / 非数値なら statusCode 判定へ委譲する", () => {
    expect(normalizeStorageError({ status: "404" as unknown, statusCode: "404" }).code).toBe(
      "STORAGE_OBJECT_NOT_FOUND",
    );
    expect(normalizeStorageError({ status: 404.5, statusCode: "409" }).code).toBe(
      "STORAGE_OBJECT_ALREADY_EXISTS",
    );
  });
});

describe("normalizeStorageError — message fallback（module 内 1 箇所限定）", () => {
  it("status / statusCode 不在時のみ message で not-found / already-exists を拾う", () => {
    expect(normalizeStorageError(new Error("Object not found")).code).toBe("STORAGE_OBJECT_NOT_FOUND");
    expect(normalizeStorageError(new Error("The resource already exists")).code).toBe(
      "STORAGE_OBJECT_ALREADY_EXISTS",
    );
  });
});

describe("normalizeStorageError — privacy（raw 値非露出）", () => {
  it("result は {code, retryable} のみ — message / URL / token / path / stack を含まない", () => {
    const inputs: unknown[] = [
      apiError(404, "404", SECRET),
      apiError(500, "500", SECRET),
      new Error(SECRET),
      { statusCode: "409", message: SECRET, url: SECRET, path: SECRET, token: SECRET },
    ];
    for (const input of inputs) {
      const r = normalizeStorageError(input);
      expectOnlyCodeAndRetryable(r);
      expect(JSON.stringify(r)).not.toContain("SECRET_PROVIDER_DETAIL");
      expect(JSON.stringify(r)).not.toContain("tok_abc123");
      expect(JSON.stringify(r)).not.toContain("internal.example");
    }
  });
});
