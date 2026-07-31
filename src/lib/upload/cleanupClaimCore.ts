// Phase 10-43-B1: cleanup claim の pure core（intent 単位 / session 単位の共通判定）。
//
// Storage 削除は長時間の DB transaction を持たずに行う:
//   1. 候補一覧を read-only で取得
//   2. conditional claim（短い update / CAS）で lease + attemptToken を立てる
//   3. claim 後に状態を再確認（候補取得後の変化を吸収）
//   4. Storage remove（transaction 外）
//   5. attemptToken 条件付きで結果を書き戻す
//
// prepare / finalize は有効な claim を検知したら開始しない（相互排他）。
// B1 では cron / route へ接続しない。

import { CLEANUP_LEASE_MS, isLeaseActive } from "./uploadIntentCore";

export { CLEANUP_LEASE_MS };

export type ClaimState = {
  cleanupLeaseUntil: Date | null;
  cleanupAttemptToken: string | null;
};

export type ClaimDecision =
  | { ok: true; leaseUntil: Date; attemptToken: string }
  | { ok: false; reason: "ALREADY_CLAIMED" };

/**
 * claim してよいか判定し、立てるべき lease 期限を返す。
 * attemptToken は呼び出し側が生成した値をそのまま使う（テスト容易性のため注入する）。
 */
export function decideClaim(args: {
  now: Date;
  state: ClaimState;
  attemptToken: string;
  leaseMs?: number;
}): ClaimDecision {
  if (isLeaseActive(args.state.cleanupLeaseUntil, args.now)) {
    return { ok: false, reason: "ALREADY_CLAIMED" };
  }
  return {
    ok: true,
    leaseUntil: new Date(args.now.getTime() + (args.leaseMs ?? CLEANUP_LEASE_MS)),
    attemptToken: args.attemptToken,
  };
}

/**
 * claim を持っている worker だけが結果を書けることを保証する述語。
 * lease が失効していても、token が一致していれば「自分の attempt の後始末」は許す
 * （Storage 削除が lease を超えて完了した場合の書き戻しを落とさない）。
 * 他 worker が claim を取り直していれば token が違うので false になる。
 */
export function ownsClaim(args: { state: ClaimState; attemptToken: string }): boolean {
  return args.state.cleanupAttemptToken !== null && args.state.cleanupAttemptToken === args.attemptToken;
}

/**
 * session 単位の cleanup claim が有効な間は prepare / finalize を始めない。
 */
export function isSessionCleanupBlocking(args: { now: Date; sessionCleanupLeaseUntil: Date | null }): boolean {
  return isLeaseActive(args.sessionCleanupLeaseUntil, args.now);
}

/**
 * claim 後の再確認。候補取得から claim までの間に状態が変わっていたら中止する。
 */
export function revalidateAfterClaim(args: {
  now: Date;
  statusAtCandidateTime: string;
  statusNow: string;
  storageCleanupNotBefore: Date;
  finalizeLeaseUntil: Date | null;
}): { proceed: true } | { proceed: false; reason: "STATUS_CHANGED" | "BEFORE_NOT_BEFORE" | "FINALIZE_IN_PROGRESS" } {
  if (args.statusAtCandidateTime !== args.statusNow) return { proceed: false, reason: "STATUS_CHANGED" };
  if (args.now.getTime() < args.storageCleanupNotBefore.getTime()) {
    return { proceed: false, reason: "BEFORE_NOT_BEFORE" };
  }
  if (isLeaseActive(args.finalizeLeaseUntil, args.now)) {
    return { proceed: false, reason: "FINALIZE_IN_PROGRESS" };
  }
  return { proceed: true };
}
