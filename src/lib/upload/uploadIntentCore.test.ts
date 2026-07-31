import { describe, it, expect } from "vitest";
import {
  canTransitionIntentStatus,
  isTerminalIntentStatus,
  computeIntentDeadlines,
  canIssueSignedUploadToken,
  tokenExpiryWithinFinalizeDeadline,
  isPastFinalizeDeadline,
  canAcquireFinalizeLease,
  isStaleFinalizeLease,
  isLeaseActive,
  evaluateCleanupEligibility,
  shouldExpireIntent,
  canMarkStorageCleanupDone,
  sanitizeErrorDetail,
  sanitizeErrorCode,
  canonicalFingerprintInput,
  isSameFingerprint,
  LAST_ERROR_DETAIL_MAX_LENGTH,
  CLEANUP_MAX_ATTEMPTS,
  SIGNED_UPLOAD_TOKEN_TTL_MS,
  type UploadIntentStatusValue,
  type CleanupCandidate,
} from "./uploadIntentCore";

const H = 60 * 60 * 1000;
const T0 = new Date("2026-08-01T00:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

describe("status transitions", () => {
  const all: UploadIntentStatusValue[] = [
    "PREPARED",
    "FINALIZING",
    "FINALIZED",
    "FAILED",
    "EXPIRED",
    "CANCELLED",
  ];

  it("PREPARED から進める先", () => {
    expect(canTransitionIntentStatus("PREPARED", "FINALIZING")).toBe(true);
    expect(canTransitionIntentStatus("PREPARED", "FAILED")).toBe(true);
    expect(canTransitionIntentStatus("PREPARED", "EXPIRED")).toBe(true);
    expect(canTransitionIntentStatus("PREPARED", "CANCELLED")).toBe(true);
    // PREPARED から直接 FINALIZED にはしない(必ず lease を取る)
    expect(canTransitionIntentStatus("PREPARED", "FINALIZED")).toBe(false);
  });

  it("FINALIZING から進める先", () => {
    expect(canTransitionIntentStatus("FINALIZING", "FINALIZED")).toBe(true);
    expect(canTransitionIntentStatus("FINALIZING", "FAILED")).toBe(true);
    expect(canTransitionIntentStatus("FINALIZING", "EXPIRED")).toBe(true);
    expect(canTransitionIntentStatus("FINALIZING", "CANCELLED")).toBe(true);
    expect(canTransitionIntentStatus("FINALIZING", "PREPARED")).toBe(false);
  });

  it("terminal からはどこへも遷移できない", () => {
    for (const from of ["FINALIZED", "FAILED", "EXPIRED", "CANCELLED"] as const) {
      expect(isTerminalIntentStatus(from)).toBe(true);
      for (const to of all) {
        expect(canTransitionIntentStatus(from, to)).toBe(false);
      }
    }
  });

  it("非 terminal は terminal 判定されない", () => {
    expect(isTerminalIntentStatus("PREPARED")).toBe(false);
    expect(isTerminalIntentStatus("FINALIZING")).toBe(false);
  });

  it("自己遷移は許可しない", () => {
    for (const s of all) expect(canTransitionIntentStatus(s, s)).toBe(false);
  });
});

describe("deadlines 22h / 24h / 25h", () => {
  const d = computeIntentDeadlines(T0);

  it("各期限が createdAt + 22/24/25h", () => {
    expect(d.tokenIssueDeadlineAt.getTime()).toBe(T0.getTime() + 22 * H);
    expect(d.intentFinalizeDeadlineAt.getTime()).toBe(T0.getTime() + 24 * H);
    expect(d.storageCleanupNotBefore.getTime()).toBe(T0.getTime() + 25 * H);
  });

  it("不変条件: token 発行期限 + TTL <= finalize 期限 < cleanup not-before", () => {
    expect(d.tokenIssueDeadlineAt.getTime() + SIGNED_UPLOAD_TOKEN_TTL_MS).toBeLessThanOrEqual(
      d.intentFinalizeDeadlineAt.getTime(),
    );
    expect(d.intentFinalizeDeadlineAt.getTime()).toBeLessThan(d.storageCleanupNotBefore.getTime());
  });

  it("token 発行は 22h 境界ちょうどまで可・1ms 超で不可", () => {
    const base = { status: "PREPARED" as const, tokenIssueDeadlineAt: d.tokenIssueDeadlineAt };
    expect(canIssueSignedUploadToken({ ...base, now: at(22 * H) })).toBe(true);
    expect(canIssueSignedUploadToken({ ...base, now: at(22 * H + 1) })).toBe(false);
  });

  it("PREPARED 以外では token を発行しない", () => {
    for (const status of ["FINALIZING", "FINALIZED", "FAILED", "EXPIRED", "CANCELLED"] as const) {
      expect(
        canIssueSignedUploadToken({ now: T0, tokenIssueDeadlineAt: d.tokenIssueDeadlineAt, status }),
      ).toBe(false);
    }
  });

  it("発行期限内の token expiry は finalize 期限内に収まる", () => {
    expect(
      tokenExpiryWithinFinalizeDeadline({
        issuedAt: at(22 * H),
        intentFinalizeDeadlineAt: d.intentFinalizeDeadlineAt,
      }),
    ).toBe(true);
    // 発行期限を 1ms 超えると不変条件が破れる(検知できること)
    expect(
      tokenExpiryWithinFinalizeDeadline({
        issuedAt: at(22 * H + 1),
        intentFinalizeDeadlineAt: d.intentFinalizeDeadlineAt,
      }),
    ).toBe(false);
  });

  it("finalize 期限は 24h 境界ちょうどでは超過扱いにしない", () => {
    expect(
      isPastFinalizeDeadline({ now: at(24 * H), intentFinalizeDeadlineAt: d.intentFinalizeDeadlineAt }),
    ).toBe(false);
    expect(
      isPastFinalizeDeadline({ now: at(24 * H + 1), intentFinalizeDeadlineAt: d.intentFinalizeDeadlineAt }),
    ).toBe(true);
  });
});

describe("finalize lease", () => {
  const deadline = at(24 * H);
  const base = {
    now: at(H),
    status: "PREPARED" as UploadIntentStatusValue,
    finalizeLeaseUntil: null as Date | null,
    cleanupLeaseUntil: null as Date | null,
    sessionCleanupLeaseUntil: null as Date | null,
    intentFinalizeDeadlineAt: deadline,
  };

  it("PREPARED は取得できる", () => {
    expect(canAcquireFinalizeLease(base)).toEqual({ ok: true });
  });

  it("FINALIZING で lease 有効なら取得できない", () => {
    const r = canAcquireFinalizeLease({
      ...base,
      status: "FINALIZING",
      finalizeLeaseUntil: at(H + 60_000),
    });
    expect(r).toEqual({ ok: false, reason: "FINALIZE_IN_PROGRESS" });
  });

  it("FINALIZING で lease 失効なら回収できる", () => {
    expect(
      canAcquireFinalizeLease({ ...base, status: "FINALIZING", finalizeLeaseUntil: at(H - 1) }),
    ).toEqual({ ok: true });
  });

  it("lease 期限ちょうどは失効扱い(回収可)", () => {
    expect(isLeaseActive(at(H), at(H))).toBe(false);
    expect(isStaleFinalizeLease({ finalizeLeaseUntil: at(H), now: at(H) })).toBe(true);
    expect(isStaleFinalizeLease({ finalizeLeaseUntil: at(H + 1), now: at(H) })).toBe(false);
    expect(isStaleFinalizeLease({ finalizeLeaseUntil: null, now: at(H) })).toBe(false);
  });

  it("FINALIZED は再取得せず既存結果を返す分類になる", () => {
    expect(canAcquireFinalizeLease({ ...base, status: "FINALIZED" })).toEqual({
      ok: false,
      reason: "ALREADY_FINALIZED",
    });
  });

  it("intent cleanup claim が有効なら取得できない(相互排他)", () => {
    expect(canAcquireFinalizeLease({ ...base, cleanupLeaseUntil: at(H + 1000) })).toEqual({
      ok: false,
      reason: "CLEANUP_IN_PROGRESS",
    });
  });

  it("session cleanup claim が有効でも取得できない", () => {
    expect(canAcquireFinalizeLease({ ...base, sessionCleanupLeaseUntil: at(H + 1000) })).toEqual({
      ok: false,
      reason: "CLEANUP_IN_PROGRESS",
    });
  });

  it("finalize 期限超過は取得できない", () => {
    expect(canAcquireFinalizeLease({ ...base, now: at(24 * H + 1) })).toEqual({
      ok: false,
      reason: "PAST_DEADLINE",
    });
  });

  it("terminal(FAILED/EXPIRED/CANCELLED)は取得できない", () => {
    for (const status of ["FAILED", "EXPIRED", "CANCELLED"] as const) {
      expect(canAcquireFinalizeLease({ ...base, status })).toEqual({
        ok: false,
        reason: "NOT_FINALIZABLE",
      });
    }
  });

  it("cleanup claim 判定は期限超過より先に評価される", () => {
    // 期限も過ぎ、cleanup claim もある場合 → cleanup 側を理由にする
    expect(
      canAcquireFinalizeLease({ ...base, now: at(24 * H + 1), cleanupLeaseUntil: at(24 * H + 2) }),
    ).toEqual({ ok: false, reason: "CLEANUP_IN_PROGRESS" });
  });
});

describe("cleanup eligibility", () => {
  const notBefore = at(25 * H);
  const c = (over: Partial<CleanupCandidate> = {}): CleanupCandidate => ({
    status: "EXPIRED",
    storageCleanupStatus: "PENDING",
    storageCleanupAttemptCount: 0,
    storageCleanupNotBefore: notBefore,
    intentFinalizeDeadlineAt: at(24 * H),
    finalizeLeaseUntil: null,
    cleanupLeaseUntil: null,
    ...over,
  });

  it("notBefore 以降・PENDING は対象", () => {
    expect(evaluateCleanupEligibility(c(), at(25 * H))).toEqual({ eligible: true });
  });

  it("notBefore より前は絶対に削除しない", () => {
    expect(evaluateCleanupEligibility(c(), at(25 * H - 1))).toEqual({
      eligible: false,
      reason: "BEFORE_NOT_BEFORE",
    });
  });

  it("DONE は対象外", () => {
    expect(evaluateCleanupEligibility(c({ storageCleanupStatus: "DONE" }), at(26 * H))).toEqual({
      eligible: false,
      reason: "ALREADY_DONE",
    });
  });

  it("FAILED は再試行対象(上限まで)", () => {
    expect(
      evaluateCleanupEligibility(c({ storageCleanupStatus: "FAILED", storageCleanupAttemptCount: 3 }), at(26 * H)),
    ).toEqual({ eligible: true });
    expect(
      evaluateCleanupEligibility(
        c({ storageCleanupStatus: "FAILED", storageCleanupAttemptCount: CLEANUP_MAX_ATTEMPTS }),
        at(26 * H),
      ),
    ).toEqual({ eligible: false, reason: "ATTEMPTS_EXHAUSTED" });
  });

  it("finalize lease が生きている intent は触らない", () => {
    expect(
      evaluateCleanupEligibility(c({ finalizeLeaseUntil: at(26 * H + 1000) }), at(26 * H)),
    ).toEqual({ eligible: false, reason: "FINALIZE_IN_PROGRESS" });
  });

  it("他 worker の cleanup claim 中は対象外", () => {
    expect(
      evaluateCleanupEligibility(c({ cleanupLeaseUntil: at(26 * H + 1000) }), at(26 * H)),
    ).toEqual({ eligible: false, reason: "CLEANUP_CLAIMED" });
  });

  it("FINALIZED intent の staging 残骸も notBefore 後は削除対象", () => {
    expect(evaluateCleanupEligibility(c({ status: "FINALIZED" }), at(25 * H))).toEqual({ eligible: true });
  });

  it("まだ finalize 可能な状態は対象外(安全弁)", () => {
    expect(
      evaluateCleanupEligibility(
        c({ status: "PREPARED", storageCleanupNotBefore: at(H), intentFinalizeDeadlineAt: at(24 * H) }),
        at(2 * H),
      ),
    ).toEqual({ eligible: false, reason: "STILL_FINALIZABLE" });
  });

  it("DONE を付けられるのは notBefore 以降だけ", () => {
    expect(canMarkStorageCleanupDone({ now: at(25 * H), storageCleanupNotBefore: notBefore })).toBe(true);
    expect(canMarkStorageCleanupDone({ now: at(25 * H - 1), storageCleanupNotBefore: notBefore })).toBe(false);
  });
});

describe("expire 判定", () => {
  const deadline = at(24 * H);

  it("期限超過した PREPARED は expire 対象", () => {
    expect(
      shouldExpireIntent({
        now: at(24 * H + 1),
        status: "PREPARED",
        intentFinalizeDeadlineAt: deadline,
        finalizeLeaseUntil: null,
      }),
    ).toBe(true);
  });

  it("期限内は expire しない", () => {
    expect(
      shouldExpireIntent({
        now: at(24 * H),
        status: "PREPARED",
        intentFinalizeDeadlineAt: deadline,
        finalizeLeaseUntil: null,
      }),
    ).toBe(false);
  });

  it("FINALIZING は lease 有効なら expire しない", () => {
    expect(
      shouldExpireIntent({
        now: at(24 * H + 1),
        status: "FINALIZING",
        intentFinalizeDeadlineAt: deadline,
        finalizeLeaseUntil: at(24 * H + 60_000),
      }),
    ).toBe(false);
    expect(
      shouldExpireIntent({
        now: at(24 * H + 1),
        status: "FINALIZING",
        intentFinalizeDeadlineAt: deadline,
        finalizeLeaseUntil: at(24 * H),
      }),
    ).toBe(true);
  });

  it("terminal は expire 対象にしない", () => {
    for (const status of ["FINALIZED", "FAILED", "EXPIRED", "CANCELLED"] as const) {
      expect(
        shouldExpireIntent({
          now: at(30 * H),
          status,
          intentFinalizeDeadlineAt: deadline,
          finalizeLeaseUntil: null,
        }),
      ).toBe(false);
    }
  });
});

describe("error sanitize", () => {
  it("256文字へ切り詰める", () => {
    const long = "x".repeat(500);
    expect(sanitizeErrorDetail(long)?.length).toBe(LAST_ERROR_DETAIL_MAX_LENGTH);
  });

  it("URL と token を落とす", () => {
    const s = sanitizeErrorDetail("failed at https://example.supabase.co/object/upload?token=abc.def sig");
    expect(s).not.toContain("supabase.co");
    expect(s).not.toContain("abc.def");
    expect(s).toContain("[url]");
  });

  it("改行・連続空白を1つにまとめる", () => {
    expect(sanitizeErrorDetail("a\n\n  b\tc")).toBe("a b c");
  });

  it("null / 空文字は null", () => {
    expect(sanitizeErrorDetail(null)).toBeNull();
    expect(sanitizeErrorDetail(undefined)).toBeNull();
    expect(sanitizeErrorDetail("   ")).toBeNull();
  });

  it("error code は大文字 + [A-Z0-9_] のみ・64文字上限", () => {
    expect(sanitizeErrorCode("storage object already-exists")).toBe("STORAGE_OBJECT_ALREADY_EXISTS");
    expect(sanitizeErrorCode("x".repeat(100))?.length).toBe(64);
    expect(sanitizeErrorCode(null)).toBeNull();
  });
});

describe("request fingerprint", () => {
  const input = {
    sessionId: "s1",
    clientUploadId: "c1",
    originalName: "a.jpg",
    declaredSizeBytes: 1024,
    declaredMimeType: "image/jpeg",
    clientFileHash: "abc",
  };

  it("同一入力は同一 canonical string(決定性)", () => {
    expect(canonicalFingerprintInput(input)).toBe(canonicalFingerprintInput({ ...input }));
  });

  it("key の記述順に依存しない", () => {
    const reordered = {
      clientFileHash: "abc",
      declaredMimeType: "image/jpeg",
      declaredSizeBytes: 1024,
      originalName: "a.jpg",
      clientUploadId: "c1",
      sessionId: "s1",
    };
    expect(canonicalFingerprintInput(reordered)).toBe(canonicalFingerprintInput(input));
  });

  it("いずれかの値が違えば別の canonical string", () => {
    const variants = [
      { ...input, sessionId: "s2" },
      { ...input, clientUploadId: "c2" },
      { ...input, originalName: "b.jpg" },
      { ...input, declaredSizeBytes: 1025 },
      { ...input, declaredMimeType: "image/png" },
      { ...input, clientFileHash: "abd" },
    ];
    const base = canonicalFingerprintInput(input);
    for (const v of variants) expect(canonicalFingerprintInput(v)).not.toBe(base);
  });

  it("fingerprint 一致判定", () => {
    expect(isSameFingerprint("a", "a")).toBe(true);
    expect(isSameFingerprint("a", "b")).toBe(false);
  });
});
