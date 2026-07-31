import "server-only";

// Phase 10-43-B1: sortOrder の唯一の発番元。
//
// 従来の `aggregate({ _max: { sortOrder } }) + 1`（POST /api/uploads/items）は
// 並行 upload（MAX_CONCURRENT=2）で同じ値を返し得る。ここでは
// upload_sessions.next_upload_sort_order を DB 側で atomic に increment し、
// 更新後の値から予約番号を決める（同時実行でも重複しない）。
//
// 移行期間中、旧 route が直接 INSERT した分は migration で追加した
// AFTER INSERT trigger が counter へ追従させる（counter は後退しない）。
//
// B1 ではまだ route へ接続しない（prepare API で使用する）。

// tx / prisma のどちらでも渡せる最小インターフェース。
// raw を使うのは「UPDATE ... RETURNING」を 1 往復で行うため
// （Prisma の update は increment 後の値を返せるが、行が無い場合の分岐と
// 条件付き更新を同じ形で扱いたいので raw に寄せる）。
export type SortOrderReservationClient = {
  $queryRaw<T = unknown>(query: TemplateStringsArray | { sql: string }, ...values: unknown[]): Promise<T>;
};

export type ReserveSortOrderResult =
  | { ok: true; sortOrder: number }
  | { ok: false; reason: "SESSION_NOT_FOUND" };

type CounterRow = { next_upload_sort_order: number };

/**
 * session の sortOrder を 1 つ予約して返す。
 *
 * 予約値は「increment 前の値」= 返却された次の空き番号。
 * 同一 session に対する同時呼び出しは行ロックで直列化されるため重複しない。
 */
export async function reserveSortOrder(
  client: { $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T> },
  sessionId: string,
): Promise<ReserveSortOrderResult> {
  const rows = await client.$queryRawUnsafe<CounterRow[]>(
    `UPDATE "upload_sessions"
        SET "next_upload_sort_order" = "next_upload_sort_order" + 1
      WHERE "id" = $1
      RETURNING "next_upload_sort_order" - 1 AS "next_upload_sort_order"`,
    sessionId,
  );

  const row = rows[0];
  if (!row) return { ok: false, reason: "SESSION_NOT_FOUND" };
  return { ok: true, sortOrder: Number(row.next_upload_sort_order) };
}
