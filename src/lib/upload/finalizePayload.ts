// Phase 10-43-B3a: POST /api/uploads/items/finalize の request payload 検証。
//
// pure（Prisma / Supabase / sharp / server-only を import しない）。
// route 接続は B3b — この module は「検証済みの intentId」だけを返す。
//
// 重要な契約:
// - 許可キーは厳密に intentId の 1 件（exact-key validation）
// - sessionId / workspaceId / path / bucket / hash / size / MIME /
//   attemptToken / sortOrder / uploadItemId は client から受け取らない
//   （キーが存在した時点で「追加キー」として拒否される）
// - hash・size・MIME 等の申告値は prepare 時に intent へ焼き込み済みで、
//   finalize では再送させない（改竄余地を作らない）
// - error message には入力値を一切含めない

export const FINALIZE_ALLOWED_KEYS = ["intentId"] as const;

// server 発行の cuid 互換 id のみ許可。separator / traversal / NUL / dot /
// query・fragment 文字は charset の時点で拒否される。
const SAFE_INTENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export type FinalizePayload = {
  intentId: string;
};

export type FinalizePayloadResult =
  | { ok: true; payload: FinalizePayload }
  | { ok: false; message: string };

const invalid = (message: string): FinalizePayloadResult => ({ ok: false, message });

export function parseFinalizePayload(body: unknown): FinalizePayloadResult {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return invalid("Request body must be a JSON object");
  }

  const raw = body as Record<string, unknown>;
  const keys = Object.keys(raw);
  const allowed = new Set<string>(FINALIZE_ALLOWED_KEYS);
  const unexpected = keys.filter((k) => !allowed.has(k));
  if (unexpected.length > 0) {
    // キー名・値とも echo しない（件数のみ）。
    return invalid(`Request body contains ${unexpected.length} unsupported field(s)`);
  }

  if (!("intentId" in raw)) {
    return invalid("Missing required field: intentId");
  }
  if (typeof raw.intentId !== "string") {
    return invalid("intentId must be a string");
  }
  const intentId = raw.intentId.trim();
  if (intentId.length === 0) {
    return invalid("intentId must not be empty");
  }
  if (!SAFE_INTENT_ID_RE.test(intentId)) {
    return invalid("intentId has an invalid format");
  }

  return { ok: true, payload: { intentId } };
}
