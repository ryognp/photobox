import { describe, it, expect } from "vitest";
import {
  decideClaim,
  ownsClaim,
  isSessionCleanupBlocking,
  revalidateAfterClaim,
  CLEANUP_LEASE_MS,
} from "./cleanupClaimCore";

const T0 = new Date("2026-08-01T00:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

describe("cleanup claim", () => {
  it("未claim なら claim でき、lease は now + 5分", () => {
    const r = decideClaim({ now: T0, state: { cleanupLeaseUntil: null, cleanupAttemptToken: null }, attemptToken: "t1" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.leaseUntil.getTime()).toBe(T0.getTime() + CLEANUP_LEASE_MS);
      expect(r.attemptToken).toBe("t1");
    }
  });

  it("有効な claim があれば取得できない(重複起動の排除)", () => {
    const r = decideClaim({
      now: T0,
      state: { cleanupLeaseUntil: at(60_000), cleanupAttemptToken: "other" },
      attemptToken: "t2",
    });
    expect(r).toEqual({ ok: false, reason: "ALREADY_CLAIMED" });
  });

  it("失効した claim は取り直せる(境界は失効扱い)", () => {
    expect(
      decideClaim({ now: T0, state: { cleanupLeaseUntil: T0, cleanupAttemptToken: "old" }, attemptToken: "t3" }).ok,
    ).toBe(true);
  });

  it("leaseMs を指定できる", () => {
    const r = decideClaim({
      now: T0,
      state: { cleanupLeaseUntil: null, cleanupAttemptToken: null },
      attemptToken: "t4",
      leaseMs: 1000,
    });
    if (r.ok) expect(r.leaseUntil.getTime()).toBe(T0.getTime() + 1000);
  });

  it("claim 失敗時は状態を変えない前提(戻り値に lease を含まない)", () => {
    const r = decideClaim({
      now: T0,
      state: { cleanupLeaseUntil: at(1000), cleanupAttemptToken: "other" },
      attemptToken: "mine",
    });
    expect(r.ok).toBe(false);
    expect("leaseUntil" in r).toBe(false);
  });
});

describe("claim ownership", () => {
  it("token 一致なら書き戻せる", () => {
    expect(ownsClaim({ state: { cleanupLeaseUntil: at(1000), cleanupAttemptToken: "mine" }, attemptToken: "mine" })).toBe(true);
  });

  it("他 worker が取り直していれば書き戻せない", () => {
    expect(ownsClaim({ state: { cleanupLeaseUntil: at(1000), cleanupAttemptToken: "other" }, attemptToken: "mine" })).toBe(false);
  });

  it("token が無い状態では書き戻せない", () => {
    expect(ownsClaim({ state: { cleanupLeaseUntil: null, cleanupAttemptToken: null }, attemptToken: "mine" })).toBe(false);
  });

  it("lease 失効後でも token 一致なら後始末を許す", () => {
    expect(ownsClaim({ state: { cleanupLeaseUntil: at(-1000), cleanupAttemptToken: "mine" }, attemptToken: "mine" })).toBe(true);
  });
});

describe("session cleanup claim による相互排他", () => {
  it("有効な session claim 中は prepare / finalize を始めない", () => {
    expect(isSessionCleanupBlocking({ now: T0, sessionCleanupLeaseUntil: at(1000) })).toBe(true);
  });

  it("claim なし・失効済みならブロックしない", () => {
    expect(isSessionCleanupBlocking({ now: T0, sessionCleanupLeaseUntil: null })).toBe(false);
    expect(isSessionCleanupBlocking({ now: T0, sessionCleanupLeaseUntil: T0 })).toBe(false);
  });
});

describe("claim 後の再確認", () => {
  const base = {
    now: at(30 * 60 * 60 * 1000),
    statusAtCandidateTime: "EXPIRED",
    statusNow: "EXPIRED",
    storageCleanupNotBefore: at(25 * 60 * 60 * 1000),
    finalizeLeaseUntil: null as Date | null,
  };

  it("状態が変わっていなければ続行", () => {
    expect(revalidateAfterClaim(base)).toEqual({ proceed: true });
  });

  it("候補取得後に status が変わっていたら中止", () => {
    expect(revalidateAfterClaim({ ...base, statusNow: "FINALIZED" })).toEqual({
      proceed: false,
      reason: "STATUS_CHANGED",
    });
  });

  it("notBefore 前なら中止", () => {
    expect(revalidateAfterClaim({ ...base, now: at(24 * 60 * 60 * 1000) })).toEqual({
      proceed: false,
      reason: "BEFORE_NOT_BEFORE",
    });
  });

  it("finalize が始まっていたら中止", () => {
    expect(
      revalidateAfterClaim({ ...base, finalizeLeaseUntil: at(31 * 60 * 60 * 1000) }),
    ).toEqual({ proceed: false, reason: "FINALIZE_IN_PROGRESS" });
  });
});
