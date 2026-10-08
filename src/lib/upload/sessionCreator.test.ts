import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createSessionEnsurer, type SessionEnsurerDeps } from "@/lib/upload/sessionCreator";

// Production incident 2026-10-07 の再現固定。
// drainQueue() の MAX_CONCURRENT = 2 により processFile が 2 本同時に開始し、
// 旧 ensureSession() が `if (sessionIdRef.current)` だけで排他していたため
// POST /api/uploads/session が 2 回飛び、session が 1 + 4 に分裂した。

const MAX_CONCURRENT = 2; // QuickAddClient.tsx と同じ値

/** sessionIdRef / POST を模した観測可能な harness。 */
function makeHarness(opts?: {
  initialSessionId?: string | null;
  /** 呼び出し回数(1始まり)を受け取り、解決する id または throw を決める。 */
  respond?: (callNo: number) => Promise<string>;
}) {
  let sessionId: string | null = opts?.initialSessionId ?? null;
  let postCount = 0;
  const created: string[] = [];

  const deps: SessionEnsurerDeps = {
    getSessionId: () => sessionId,
    requestSession: async () => {
      postCount += 1;
      const n = postCount;
      if (opts?.respond) return opts.respond(n);
      // 既定: 1 tick 遅延してから id を返す（network 往復の代用）
      await Promise.resolve();
      return `session-${n}`;
    },
    onSessionCreated: (id) => {
      created.push(id);
      sessionId = id;
    },
  };

  return {
    ensure: createSessionEnsurer(deps),
    get postCount() {
      return postCount;
    },
    get sessionId() {
      return sessionId;
    },
    get created() {
      return created;
    },
  };
}

/** MAX_CONCURRENT を上限に n 件を並行処理する drainQueue 相当。 */
async function drainQueue(
  fileCount: number,
  ensure: () => Promise<string>,
  concurrency = MAX_CONCURRENT,
): Promise<string[]> {
  const queue = Array.from({ length: fileCount }, (_, i) => i);
  const used: string[] = [];
  async function worker() {
    while (queue.length > 0) {
      queue.shift();
      used.push(await ensure());
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return used;
}

describe("createSessionEnsurer — session 作成の concurrency 契約", () => {
  it("T1) 同時初回呼び出しでも POST は 1 回・両者が同じ sessionId を得る", async () => {
    const h = makeHarness();

    // 2 本を同一 tick で開始する（await を挟まない）= 旧実装が壊れた条件
    const pA = h.ensure();
    const pB = h.ensure();
    const [a, b] = await Promise.all([pA, pB]);

    expect(h.postCount).toBe(1);
    expect(a).toBe(b);
    expect(h.sessionId).toBe(a);
    expect(h.created).toEqual([a]);
  });

  it("T2) MAX_CONCURRENT=2 相当の 2 件同時処理で session 作成は 1 回・両 item が同一 session", async () => {
    const h = makeHarness();

    const used = await drainQueue(2, h.ensure);

    expect(h.postCount).toBe(1);
    expect(used).toHaveLength(2);
    expect(new Set(used).size).toBe(1);
  });

  it("T3) 5 件を MAX_CONCURRENT=2 で処理しても session 作成は 1 回・全件が同一 session（incident 再現）", async () => {
    const h = makeHarness();

    const used = await drainQueue(5, h.ensure);

    expect(h.postCount).toBe(1);
    expect(used).toHaveLength(5);
    expect(new Set(used).size).toBe(1);
    expect(used.every((id) => id === h.sessionId)).toBe(true);
  });

  it("T4) sessionId が確定済みなら POST は 0 回で既存 id を返す", async () => {
    const h = makeHarness({ initialSessionId: "existing-session" });

    const [a, b] = await Promise.all([h.ensure(), h.ensure()]);

    expect(h.postCount).toBe(0);
    expect(a).toBe("existing-session");
    expect(b).toBe("existing-session");
    expect(h.created).toEqual([]);
  });

  it("T5) 初回 POST が失敗しても in-flight は解除され、次回は再試行できる", async () => {
    const h = makeHarness({
      respond: async (n) => {
        if (n === 1) throw new Error("セッション作成に失敗しました");
        return `session-${n}`;
      },
    });

    await expect(h.ensure()).rejects.toThrow("セッション作成に失敗しました");
    expect(h.postCount).toBe(1);
    expect(h.sessionId).toBeNull();

    // rejected Promise が残留していれば、ここで同じ失敗が返るか POST が増えない
    const retried = await h.ensure();
    expect(h.postCount).toBe(2);
    expect(retried).toBe("session-2");
    expect(h.sessionId).toBe("session-2");
  });

  it("T6) 並行 caller が共有した POST が失敗した場合、POST は 1 回・両者が同じ失敗を受け・再試行できる", async () => {
    const h = makeHarness({
      respond: async (n) => {
        if (n === 1) throw new Error("boom");
        return `session-${n}`;
      },
    });

    const pA = h.ensure();
    const pB = h.ensure();
    const settled = await Promise.allSettled([pA, pB]);

    expect(h.postCount).toBe(1);
    expect(settled.map((s) => s.status)).toEqual(["rejected", "rejected"]);
    const reasons = settled.map((s) => (s as PromiseRejectedResult).reason as Error);
    expect(reasons[0]).toBe(reasons[1]); // 同一 error instance = 同じ POST を共有
    expect(reasons[0].message).toBe("boom");

    const retried = await h.ensure();
    expect(h.postCount).toBe(2);
    expect(retried).toBe("session-2");
  });

  it("T7) 作成中に別経路で sessionId が確定した場合、遅れて解決した Promise が上書きしない", async () => {
    let sessionId: string | null = null;
    let postCount = 0;
    const created: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const ensure = createSessionEnsurer({
      getSessionId: () => sessionId,
      requestSession: async () => {
        postCount += 1;
        await gate; // 応答を保留する
        return "late-session";
      },
      onSessionCreated: (id) => {
        created.push(id);
        sessionId = id;
      },
    });

    const p = ensure();
    // 応答待ちの間に restore 等で確定したとみなす
    sessionId = "restored-session";
    release();

    await expect(p).resolves.toBe("restored-session");
    expect(postCount).toBe(1);
    expect(created).toEqual([]); // 上書きしていない
    expect(sessionId).toBe("restored-session");
  });
});

describe("QuickAddClient の wiring（旧 inline 実装へ戻っていないこと）", () => {
  const clientSrc = readFileSync(
    path.resolve(process.cwd(), "src/app/quick-add/QuickAddClient.tsx"),
    "utf-8",
  );

  it("W1) ensureSession は共有 ensurer 経由で、POST を直書きしていない", () => {
    expect(clientSrc).toContain("createSessionEnsurer({");
    expect(clientSrc).toContain("ensureSessionRef.current()");
    // 旧実装の check-then-act 形が復活していない
    expect(clientSrc).not.toContain("if (sessionIdRef.current) return sessionIdRef.current;");
  });

  it("W2) POST /api/uploads/session は requestSession の 1 箇所だけ", () => {
    const occurrences = clientSrc.split('fetch("/api/uploads/session"').length - 1;
    expect(occurrences).toBe(1);
  });
});
