// Quick Add の upload session 作成を concurrency-safe にするための最小 helper。
//
// 背景（Production incident 2026-10-07）:
// QuickAddClient の drainQueue() は MAX_CONCURRENT 本の processFile を同時に
// 開始する。各本が `if (sessionIdRef.current) return ...` だけで排他していた
// ため、2 本が同時に null を通過し、POST /api/uploads/session が 2 回実行されて
// session が 2 つ作られた。結果、初回に選択した画像群が複数 session へ分裂した
// （実測: 36ms 差で 2 session 作成 → items 1 + 4 に分裂）。
//
// 確定契約:
// - 1 つの ensurer（= Quick Add の 1 lifecycle）につき、同時に飛ぶ session 作成
//   request は最大 1 本。並行 caller は進行中の Promise を共有する
// - 失敗した Promise はキャッシュしない。次の呼び出しで再試行できる
// - sessionId が確定済みなら request は一切発行しない
// - 作成完了時に既に別経路（restore 等）で sessionId が確定していれば、そちらを
//   正本として返す。遅れて解決した Promise が新しい状態を上書きしない

export type SessionEnsurer = () => Promise<string>;

export type SessionEnsurerDeps = {
  /** 現在確定している sessionId。未確定なら null。 */
  getSessionId: () => string | null;
  /** session 作成 request を 1 回実行し、新しい sessionId を返す。 */
  requestSession: () => Promise<string>;
  /** 作成した id を正本として採用したときだけ呼ばれる（永続化・state 反映）。 */
  onSessionCreated: (sessionId: string) => void;
};

export function createSessionEnsurer(deps: SessionEnsurerDeps): SessionEnsurer {
  // 進行中の作成 Promise。null = 進行中なし。
  let inFlight: Promise<string> | null = null;

  return function ensureSession(): Promise<string> {
    const existing = deps.getSessionId();
    if (existing) return Promise.resolve(existing);
    if (inFlight) return inFlight;

    const promise = (async () => {
      const created = await deps.requestSession();
      // 作成中に別経路で確定していたら、そちらを正本とする（上書きしない）。
      const current = deps.getSessionId();
      if (current) return current;
      deps.onSessionCreated(created);
      return created;
    })();

    // `promise` の生成から この代入までの間に await による中断点はないため、
    // 他の caller が inFlight を観測できるのは必ずこの代入の後になる。
    // これが check-then-act race を塞ぐ本質。
    inFlight = promise;

    // 失敗した Promise を残留させない。自分が張った Promise のときだけ解除し、
    // 後続の新しい作成（stale な解除）を壊さない。
    void promise
      .catch(() => undefined)
      .finally(() => {
        if (inFlight === promise) inFlight = null;
      });

    return promise;
  };
}
