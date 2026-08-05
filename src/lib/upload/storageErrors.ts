// Phase 10-43-B3b-1: Supabase Storage error の正規化。
//
// pure（server-only / Supabase client / provider class を import しない）。
// installed @supabase/storage-js 2.108.2 の実体で確認済みの安定フィールド
//   StorageApiError.status: number（HTTP status。常に存在）
//   StorageApiError.statusCode: string（body.statusCode || body.code || String(status)）
// を duck-typing で読む（`instanceof` へ依存しない — mock / 他 realm でも成立）。
// 非 HTTP 失敗（network / DNS / timeout / AbortError）は StorageUnknownError に
// 包まれ status/statusCode とも undefined になるため、UNKNOWN(retryable) へ落ちる。
//
// 重要な契約:
// - どんな入力でも throw しない（getter が throw する object を含む）
// - 戻り値は固定分類 + retryable のみ。raw message / URL / token / path /
//   stack / originalError を一切含めない（漏洩防止の関門）
// - message の正規表現 fallback はこの module 内の 1 関数に隔離し、
//   route / domain logic へ provider 文字列を散在させない
// - status と statusCode が矛盾した場合は status（HTTP 層の事実）を優先する。
//   status で分類できない場合（400 等・undefined）のみ statusCode を参照する

export type StorageErrorCode =
  | "STORAGE_OBJECT_ALREADY_EXISTS"
  | "STORAGE_OBJECT_NOT_FOUND"
  | "STORAGE_UNAUTHORIZED"
  | "STORAGE_RATE_LIMITED"
  | "STORAGE_UNKNOWN";

export type NormalizedStorageError = {
  code: StorageErrorCode;
  retryable: boolean;
};

const RESULT: Record<StorageErrorCode, NormalizedStorageError> = {
  STORAGE_OBJECT_ALREADY_EXISTS: { code: "STORAGE_OBJECT_ALREADY_EXISTS", retryable: false },
  STORAGE_OBJECT_NOT_FOUND: { code: "STORAGE_OBJECT_NOT_FOUND", retryable: false },
  STORAGE_UNAUTHORIZED: { code: "STORAGE_UNAUTHORIZED", retryable: false },
  STORAGE_RATE_LIMITED: { code: "STORAGE_RATE_LIMITED", retryable: true },
  STORAGE_UNKNOWN: { code: "STORAGE_UNKNOWN", retryable: true },
};

const freshResult = (code: StorageErrorCode): NormalizedStorageError => ({ ...RESULT[code] });

// own property のみを安全に読む。prototype 由来の値（"toString" 等の関数や
// 汚染された prototype chain）を誤って provider field として信頼しない。
// getter が throw しても外へ伝播させない。
function safeOwnField(input: unknown, key: string): unknown {
  if (input === null || typeof input !== "object") return undefined;
  try {
    if (!Object.prototype.hasOwnProperty.call(input, key)) return undefined;
    return (input as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

// Error.name は built-in prototype 上にあるため own 限定にしない（分類先は
// いずれも UNKNOWN/retryable のみで、安全側にしか作用しない）。
function safeName(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  try {
    const name = (input as { name?: unknown }).name;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

function classifyByStatus(status: number): StorageErrorCode | null {
  if (status === 404) return "STORAGE_OBJECT_NOT_FOUND";
  if (status === 409) return "STORAGE_OBJECT_ALREADY_EXISTS";
  if (status === 401 || status === 403) return "STORAGE_UNAUTHORIZED";
  if (status === 429) return "STORAGE_RATE_LIMITED";
  if (status >= 500 && status <= 599) return "STORAGE_UNKNOWN";
  // 400 その他は status 単独では分類しない（statusCode へ委譲）。
  return null;
}

function classifyByStatusCode(statusCode: string): StorageErrorCode | null {
  if (statusCode === "404" || /not.?found|nosuchkey/i.test(statusCode)) {
    return "STORAGE_OBJECT_NOT_FOUND";
  }
  if (statusCode === "409" || /duplicate|already.?exists?/i.test(statusCode)) {
    return "STORAGE_OBJECT_ALREADY_EXISTS";
  }
  if (statusCode === "401" || statusCode === "403" || /unauthori[sz]|forbidden|access.?denied/i.test(statusCode)) {
    return "STORAGE_UNAUTHORIZED";
  }
  if (statusCode === "429" || /rate.?limit|too.?many/i.test(statusCode)) {
    return "STORAGE_RATE_LIMITED";
  }
  return null;
}

// 最後の手段。provider message の部分一致はここ 1 箇所だけに存在する。
function classifyByMessage(message: string): StorageErrorCode | null {
  if (/not.?found/i.test(message)) return "STORAGE_OBJECT_NOT_FOUND";
  if (/already exists?|duplicate/i.test(message)) return "STORAGE_OBJECT_ALREADY_EXISTS";
  return null;
}

/**
 * Storage 呼び出しの失敗値（`{ error }` の error、または throw された値）を
 * 固定分類へ正規化する。分類不能は常に UNKNOWN(retryable) — 誤って成功側や
 * fatal 側へ倒れることはない安全側 default。
 */
export function normalizeStorageError(input: unknown): NormalizedStorageError {
  // network / timeout / abort（HTTP 応答が存在しない失敗）。
  const name = safeName(input);
  if (name === "AbortError" || name === "TimeoutError") {
    return freshResult("STORAGE_UNKNOWN");
  }

  const rawStatus = safeOwnField(input, "status");
  const status =
    typeof rawStatus === "number" && Number.isInteger(rawStatus) ? rawStatus : undefined;
  if (status !== undefined) {
    const byStatus = classifyByStatus(status);
    if (byStatus) return freshResult(byStatus);
  }

  const rawStatusCode = safeOwnField(input, "statusCode");
  const statusCode = typeof rawStatusCode === "string" ? rawStatusCode : undefined;
  if (statusCode !== undefined) {
    const byCode = classifyByStatusCode(statusCode);
    if (byCode) return freshResult(byCode);
  }

  const rawMessage = safeOwnField(input, "message");
  const message = typeof rawMessage === "string" ? rawMessage : undefined;
  if (message !== undefined) {
    const byMessage = classifyByMessage(message);
    if (byMessage) return freshResult(byMessage);
  }

  return freshResult("STORAGE_UNKNOWN");
}
