// Phase 10-43-B3c-1: intentCleanupLifecycle の unit test。
// 本 module は cleanup eligibility / ownership / failure disposition の唯一の
// 正本であり、旧 attempt 上限契約（10 回で retry 永久停止）が復活しないことを
// ここで固定する。

import { describe, it, expect } from "vitest";
import {
  classifyCleanupFailureCode,
  classifyIntentCleanup,
  listOwnedObjectKinds,
  RETRYABLE_CLEANUP_FAILURE_CODES,
  TERMINAL_CLEANUP_FAILURE_CODES,
  type IntentCleanupSnapshot,
} from "./intentCleanupLifecycle";

const H = 60 * 60 * 1000;
const T0 = new Date("2026-08-01T00:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

// 既定: EXPIRED / PENDING / notBefore(25h) ちょうどの時刻で eligible になる snapshot。
const snap = (over: Partial<IntentCleanupSnapshot> = {}): IntentCleanupSnapshot => ({
  now: at(25 * H),
  status: "EXPIRED",
  storageCleanupStatus: "PENDING",
  storageCleanupLastErrorCode: null,
  storageCleanupAttemptCount: 0,
  storageCleanupNotBefore: at(25 * H),
  intentFinalizeDeadlineAt: at(24 * H),
  finalizeLeaseUntil: null,
  intentCleanupLeaseUntil: null,
  sessionCleanupLeaseUntil: null,
  hasCanonicalPath: false,
  liveUploadItemExists: false,
  ...over,
});

// ---------------------------------------------------------------------------
// Retry / dead-letter
// ---------------------------------------------------------------------------

describe("failure disposition", () => {
  it("PENDING は通常候補（failure code に関係なく eligible）", () => {
    const r = classifyIntentCleanup(snap());
    expect(r).toEqual({
      eligible: true,
      expireIntent: false,
      ownedObjectKinds: ["STAGING_ORIGINAL"],
      retryingFailedCleanup: false,
    });
  });

  it.each(["STORAGE_RATE_LIMITED", "STORAGE_UNKNOWN", "DB_WRITE_FAILED"])(
    "FAILED + %s は retryable（eligible・retryingFailedCleanup=true）",
    (code) => {
      const r = classifyIntentCleanup(
        snap({ storageCleanupStatus: "FAILED", storageCleanupLastErrorCode: code }),
      );
      expect(r.eligible).toBe(true);
      if (r.eligible) expect(r.retryingFailedCleanup).toBe(true);
    },
  );

  it.each(["PATH_MISMATCH", "STORAGE_UNAUTHORIZED", "IDENTITY_CORRUPT"])(
    "FAILED + %s は dead-letter（候補外）",
    (code) => {
      expect(
        classifyIntentCleanup(snap({ storageCleanupStatus: "FAILED", storageCleanupLastErrorCode: code })),
      ).toEqual({ eligible: false, reason: "DEAD_LETTER" });
    },
  );

  it("FAILED + 未知 code / null / 空文字は dead-letter（無限 retry へ倒さない）", () => {
    for (const code of ["TOTALLY_UNKNOWN_CODE_XYZ", null, "", "storage_rate_limited"]) {
      expect(
        classifyIntentCleanup(snap({ storageCleanupStatus: "FAILED", storageCleanupLastErrorCode: code })),
      ).toEqual({ eligible: false, reason: "DEAD_LETTER" });
    }
  });

  it("classifyCleanupFailureCode は raw code を echo せず固定 2 値のみ返す", () => {
    expect(classifyCleanupFailureCode("STORAGE_UNKNOWN")).toBe("RETRYABLE");
    expect(classifyCleanupFailureCode("SENTINEL_RAW_CODE")).toBe("DEAD_LETTER");
    expect(classifyCleanupFailureCode(null)).toBe("DEAD_LETTER");
    expect(classifyCleanupFailureCode(undefined)).toBe("DEAD_LETTER");
  });

  it("retryable / terminal の固定集合が凍結されている（B3c-3 candidate query の正本）", () => {
    expect([...RETRYABLE_CLEANUP_FAILURE_CODES]).toEqual([
      "STORAGE_RATE_LIMITED",
      "STORAGE_UNKNOWN",
      "DB_WRITE_FAILED",
    ]);
    expect([...TERMINAL_CLEANUP_FAILURE_CODES]).toEqual([
      "PATH_MISMATCH",
      "STORAGE_UNAUTHORIZED",
      "IDENTITY_CORRUPT",
    ]);
    expect(Object.isFrozen(RETRYABLE_CLEANUP_FAILURE_CODES)).toBe(true);
    expect(Object.isFrozen(TERMINAL_CLEANUP_FAILURE_CODES)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Attempt count は観測専用（旧 10 回 gate の復活を直接検出する）
// ---------------------------------------------------------------------------

describe("attemptCount は観測専用", () => {
  const attempts = [0, 9, 10, 100, Number.MAX_SAFE_INTEGER];

  it("同一 retryable FAILED は attemptCount 0/9/10/100/MAX_SAFE_INTEGER で完全同一の結果", () => {
    const results = attempts.map((n) =>
      classifyIntentCleanup(
        snap({
          storageCleanupStatus: "FAILED",
          storageCleanupLastErrorCode: "STORAGE_UNKNOWN",
          storageCleanupAttemptCount: n,
        }),
      ),
    );
    for (const r of results) expect(r).toEqual(results[0]);
    expect(results[0].eligible).toBe(true);
  });

  it("PENDING でも attemptCount に依存しない", () => {
    const results = attempts.map((n) => classifyIntentCleanup(snap({ storageCleanupAttemptCount: n })));
    for (const r of results) expect(r).toEqual(results[0]);
    expect(results[0].eligible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Boundary（notBefore / lease / deadline）
// ---------------------------------------------------------------------------

describe("境界", () => {
  it("notBefore 直前は BEFORE_NOT_BEFORE・ちょうどは許可・直後も許可", () => {
    expect(classifyIntentCleanup(snap({ now: at(25 * H - 1) }))).toEqual({
      eligible: false,
      reason: "BEFORE_NOT_BEFORE",
    });
    expect(classifyIntentCleanup(snap({ now: at(25 * H) })).eligible).toBe(true);
    expect(classifyIntentCleanup(snap({ now: at(25 * H + 1) })).eligible).toBe(true);
  });

  it("finalize lease 直前（leaseUntil > now）は FINALIZE_IN_PROGRESS・ちょうど（== now）は inactive", () => {
    expect(classifyIntentCleanup(snap({ finalizeLeaseUntil: at(25 * H + 1) }))).toEqual({
      eligible: false,
      reason: "FINALIZE_IN_PROGRESS",
    });
    expect(classifyIntentCleanup(snap({ finalizeLeaseUntil: at(25 * H) })).eligible).toBe(true);
  });

  it("intent cleanup claim active は INTENT_CLEANUP_IN_PROGRESS", () => {
    expect(classifyIntentCleanup(snap({ intentCleanupLeaseUntil: at(25 * H + 1) }))).toEqual({
      eligible: false,
      reason: "INTENT_CLEANUP_IN_PROGRESS",
    });
    expect(classifyIntentCleanup(snap({ intentCleanupLeaseUntil: at(25 * H) })).eligible).toBe(true);
  });

  it("session cleanup claim active は SESSION_CLEANUP_IN_PROGRESS", () => {
    expect(classifyIntentCleanup(snap({ sessionCleanupLeaseUntil: at(25 * H + 1) }))).toEqual({
      eligible: false,
      reason: "SESSION_CLEANUP_IN_PROGRESS",
    });
    expect(classifyIntentCleanup(snap({ sessionCleanupLeaseUntil: at(25 * H) })).eligible).toBe(true);
  });

  it("deadline 直前 / ちょうどの PREPARED は STILL_FINALIZABLE・deadline+1ms で expire つき eligible", () => {
    // 安全弁経路: notBefore を deadline より前へ倒した snapshot で検証する
    const base = snap({
      status: "PREPARED",
      storageCleanupNotBefore: at(1 * H),
      intentFinalizeDeadlineAt: at(24 * H),
    });
    expect(classifyIntentCleanup({ ...base, now: at(24 * H - 1) })).toEqual({
      eligible: false,
      reason: "STILL_FINALIZABLE",
    });
    expect(classifyIntentCleanup({ ...base, now: at(24 * H) })).toEqual({
      eligible: false,
      reason: "STILL_FINALIZABLE",
    });
    const past = classifyIntentCleanup({ ...base, now: at(24 * H + 1) });
    expect(past).toEqual({
      eligible: true,
      expireIntent: true,
      ownedObjectKinds: ["STAGING_ORIGINAL"],
      retryingFailedCleanup: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Status 別
// ---------------------------------------------------------------------------

describe("status 別分類", () => {
  it("PREPARED + deadline 超過（通常経路: notBefore=25h）は expire つき eligible", () => {
    const r = classifyIntentCleanup(snap({ status: "PREPARED" }));
    expect(r).toEqual({
      eligible: true,
      expireIntent: true,
      ownedObjectKinds: ["STAGING_ORIGINAL"],
      retryingFailedCleanup: false,
    });
  });

  it("FINALIZING + active lease は deadline 超過でも不変（cleanup も expire もしない）", () => {
    expect(
      classifyIntentCleanup(snap({ status: "FINALIZING", finalizeLeaseUntil: at(25 * H + 60_000) })),
    ).toEqual({ eligible: false, reason: "FINALIZE_IN_PROGRESS" });
  });

  it("FINALIZING + stale lease（== now は失効）は expire つき eligible", () => {
    const r = classifyIntentCleanup(
      snap({ status: "FINALIZING", finalizeLeaseUntil: at(25 * H), hasCanonicalPath: true }),
    );
    expect(r).toEqual({
      eligible: true,
      expireIntent: true,
      ownedObjectKinds: ["STAGING_ORIGINAL", "CANONICAL_ORIGINAL", "THUMBNAIL", "PREVIEW"],
      retryingFailedCleanup: false,
    });
  });

  it("FINALIZED は expire なしで eligible（staging 残骸の回収）", () => {
    const r = classifyIntentCleanup(snap({ status: "FINALIZED", liveUploadItemExists: true, hasCanonicalPath: true }));
    expect(r).toEqual({
      eligible: true,
      expireIntent: false,
      ownedObjectKinds: ["STAGING_ORIGINAL"],
      retryingFailedCleanup: false,
    });
  });

  it.each(["FAILED", "EXPIRED", "CANCELLED"] as const)("%s（terminal）は expire なしで eligible", (status) => {
    const r = classifyIntentCleanup(snap({ status }));
    expect(r.eligible).toBe(true);
    if (r.eligible) expect(r.expireIntent).toBe(false);
  });

  it("DONE は常に ALREADY_DONE（他条件より優先）", () => {
    expect(
      classifyIntentCleanup(
        snap({ storageCleanupStatus: "DONE", finalizeLeaseUntil: at(25 * H + 1), now: at(20 * H) }),
      ),
    ).toEqual({ eligible: false, reason: "ALREADY_DONE" });
  });
});

// ---------------------------------------------------------------------------
// C' ownership
// ---------------------------------------------------------------------------

describe("C' ownership", () => {
  it("canonical path なし → staging のみ", () => {
    expect(listOwnedObjectKinds({ hasCanonicalPath: false, liveUploadItemExists: false })).toEqual([
      "STAGING_ORIGINAL",
    ]);
  });

  it("canonical path あり + live item あり → staging のみ（canonical / variants は item 所有）", () => {
    expect(listOwnedObjectKinds({ hasCanonicalPath: true, liveUploadItemExists: true })).toEqual([
      "STAGING_ORIGINAL",
    ]);
  });

  it("canonical path あり + item なし → 4 種（決定的順序・重複なし）", () => {
    const kinds = listOwnedObjectKinds({ hasCanonicalPath: true, liveUploadItemExists: false });
    expect(kinds).toEqual(["STAGING_ORIGINAL", "CANONICAL_ORIGINAL", "THUMBNAIL", "PREVIEW"]);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it("FINALIZED + item なし（hard delete 済み orphan）は 4 種を所有", () => {
    const r = classifyIntentCleanup(
      snap({ status: "FINALIZED", hasCanonicalPath: true, liveUploadItemExists: false }),
    );
    expect(r.eligible).toBe(true);
    if (r.eligible) {
      expect(r.ownedObjectKinds).toEqual([
        "STAGING_ORIGINAL",
        "CANONICAL_ORIGINAL",
        "THUMBNAIL",
        "PREVIEW",
      ]);
    }
  });

  it("terminal + canonical orphan（FAILED で canonical path あり）も 4 種", () => {
    const r = classifyIntentCleanup(snap({ status: "FAILED", hasCanonicalPath: true }));
    expect(r.eligible).toBe(true);
    if (r.eligible) expect(r.ownedObjectKinds).toContain("CANONICAL_ORIGINAL");
  });
});

// ---------------------------------------------------------------------------
// Privacy / immutability
// ---------------------------------------------------------------------------

describe("privacy / immutability", () => {
  it("result へ raw code sentinel を echo しない", () => {
    const sentinel = "RAW_SENTINEL_CODE_12345";
    const r = classifyIntentCleanup(
      snap({ storageCleanupStatus: "FAILED", storageCleanupLastErrorCode: sentinel }),
    );
    expect(JSON.stringify(r)).not.toContain(sentinel);
  });

  it("eligible result の key / shape が固定されている", () => {
    const r = classifyIntentCleanup(snap());
    expect(r.eligible).toBe(true);
    if (r.eligible) {
      expect(Object.keys(r).sort()).toEqual([
        "eligible",
        "expireIntent",
        "ownedObjectKinds",
        "retryingFailedCleanup",
      ]);
    }
  });

  it("result の配列を呼び出し側が破壊しても次回結果へ漏れない（shared mutable なし）", () => {
    const r1 = classifyIntentCleanup(snap({ hasCanonicalPath: true }));
    expect(r1.eligible).toBe(true);
    if (r1.eligible) {
      r1.ownedObjectKinds.length = 0; // 呼び出し側の破壊
    }
    const r2 = classifyIntentCleanup(snap({ hasCanonicalPath: true }));
    expect(r2.eligible).toBe(true);
    if (r2.eligible) {
      expect(r2.ownedObjectKinds).toEqual([
        "STAGING_ORIGINAL",
        "CANONICAL_ORIGINAL",
        "THUMBNAIL",
        "PREVIEW",
      ]);
    }
    const l1 = listOwnedObjectKinds({ hasCanonicalPath: false, liveUploadItemExists: false });
    l1.push("PREVIEW");
    expect(listOwnedObjectKinds({ hasCanonicalPath: false, liveUploadItemExists: false })).toEqual([
      "STAGING_ORIGINAL",
    ]);
  });
});
