// Phase 10-43-B4: Direct Upload orchestrator for Quick Add.
//
// Frozen Plan §44-§60 を唯一の正本として実装する。外部契約は既存 `uploadFile()`
// と同一 signature・同一 `UploadResult`。QuickAddClient は
// `selectUploadFileFn(directUploadEnabled)` の戻り値だけを呼び、経路の排他
// （legacy か Direct のどちらか一方のみ）はこの module が保証する。
//
// 確定契約（Plan §46-§51）:
// - legacy fallback は「Prepare の exact gate-404」のみ（HTTP 404 ∧ JSON ∧
//   code==="NOT_FOUND" ∧ message==="Not found"）。network / 5xx / 429 /
//   他の 404 では fallback しない
// - Prepare 成功後は legacy fallback・新 clientUploadId・新 intent とも禁止。
//   1 operation は単一 intentId のみを使う（probe / replay 含む）
// - signed upload の失敗は分類を問わず一律に同一 intentId で Finalize を
//   1 回実行して照合する（Finalize-probe）。upload の再送はしない
// - Finalize の replay 対象（応答喪失 / 5xx / retryable 409 / 429）は
//   同一 intentId の bounded replay（初回 1 + replay 最大 4 = 最大 5 request）。
//   429 の Retry-After は client 側でも 60 秒へ cap する（defence-in-depth。
//   最悪総待機は 60+60+60+90 = 270 秒で有界）
// - 放棄・失敗の残骸（intent / staging）は B3c cleanup が回収する。client 側の
//   削除処理・cancel API・reload resume は持たない
// - token / path / expiresAt は関数内の一時値としてのみ保持し、React state /
//   log / error message / result へ露出しない
//
// server 専用の lease 定数・server 専用 module・環境変数はこの module へ
// import しない（replay budget が server の finalize lease(120s) を必ず上回る
// 不変条件は directUploadClient.test.ts の test-only import が固定する）。

import { uploadFile, type UploadProgress, type UploadResult, type SignedUrls } from "./uploadClient";
import { sha256Hex } from "./hashClient";
import { generateWebpBlob } from "./thumbnailClient";
import { isJsonContentType } from "./preparePayload";
import { createClient } from "@/lib/supabase/client";

// ---------------------------------------------------------------------------
// Bounded replay 定数（Plan §51-3 の exact 値）
// ---------------------------------------------------------------------------

// 初回 1 request + replay 最大 4 = 最大 5 Finalize request / operation。
// 累計 155_000ms は server の finalize lease(120s) を必ず跨ぐ（crashed-lease の
// 最悪ケースでも最終 replay が stale 回収 CAS に到達する）。
export const DIRECT_FINALIZE_REPLAY_DELAYS_MS: readonly number[] = [5_000, 15_000, 45_000, 90_000];

// 429 Retry-After（秒）の client 側上限。app rate limiter の正式契約は 1〜60 秒
// （sliding window 1m）だが、経路上の別 component が発行した巨大値へ無制限に
// 従わないための defence-in-depth。module 内部専用（export しない）。
const MAX_FINALIZE_RETRY_AFTER_SECONDS = 60;

// replay 対象の 409 は server 側 retryable:true の固定 code allowlist のみ。
// OBJECT_MISSING は「bytes 未到達の確定 verdict」であり対象外（fatal）。
const RETRYABLE_FINALIZE_409_CODES: ReadonlySet<string> = new Set([
  "FINALIZE_IN_PROGRESS",
  "CONFLICT",
  "SESSION_CLEANUP_IN_PROGRESS",
  "INTENT_CLEANUP_IN_PROGRESS",
]);

// ---------------------------------------------------------------------------
// 内部 helpers（Response 分類。message は server の固定 envelope 文のみを使う）
// ---------------------------------------------------------------------------

type ErrorEnvelope = { code: string; message: string };

async function readErrorEnvelope(res: Response): Promise<ErrorEnvelope | null> {
  if (!isJsonContentType(res.headers.get("content-type"))) return null;
  try {
    const json = (await res.json()) as { error?: { code?: unknown; message?: unknown } };
    const code = json?.error?.code;
    const message = json?.error?.message;
    if (typeof code === "string" && typeof message === "string") return { code, message };
    return null;
  } catch {
    return null;
  }
}

function errorMessageOf(e: unknown): string {
  return e instanceof Error && e.message.length > 0 ? e.message : "Upload failed";
}

// 429 の Retry-After header を ms へ変換する。有効なのは「正の 10 進整数
// （safe integer・1 以上）」のみで、60 秒上限へ cap する。欠落・空白・0・負数・
// 小数・指数表記・HTTP-date・非数・safe integer 超過は null（= base delay）。
function parseRetryAfterMs(raw: string | null): number | null {
  const trimmed = raw?.trim() ?? "";
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return null;
  return Math.min(parsed, MAX_FINALIZE_RETRY_AFTER_SECONDS) * 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type FinalizeAttemptOutcome =
  | { kind: "success"; item: Record<string, unknown>; signedUrls: SignedUrls }
  | { kind: "replayable"; retryAfterMs: number | null; message: string }
  | { kind: "fatal"; message: string };

async function finalizeOnce(intentId: string): Promise<FinalizeAttemptOutcome> {
  let res: Response;
  try {
    res = await fetch("/api/uploads/items/finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intentId }),
    });
  } catch (e) {
    // 応答喪失 / network 断 — bytes・DB の状態は確定できない → replay 対象
    return { kind: "replayable", retryAfterMs: null, message: errorMessageOf(e) };
  }

  if (res.ok) {
    // 201 = 初回成功 / 200 = FINALIZED replay（冪等）。同一 data shape。
    try {
      const json = (await res.json()) as {
        data?: { item?: Record<string, unknown>; signedUrls?: SignedUrls };
      };
      const item = json?.data?.item;
      const signedUrls = json?.data?.signedUrls;
      if (item && signedUrls) return { kind: "success", item, signedUrls };
    } catch {
      // fallthrough: 成功 status だが body が読めない = response loss の一種
    }
    // 成功 status で body 欠損 → 同一 intentId の replay（200）が回復する
    return { kind: "replayable", retryAfterMs: null, message: "Upload failed" };
  }

  const envelope = await readErrorEnvelope(res);
  const message = envelope?.message ?? `Upload failed: ${res.status}`;

  // 5xx（500〜599）は全て同一 intentId の replay 対象。app の transient 500 に
  // 加え、gateway 系 502/503/504 も応答喪失と同クラス（bytes・DB の確定状態を
  // client から判別できない）として扱う。fatal 500（CANONICAL conflict）は
  // message 文字列で判別せず、intent が FAILED 済みのため次の replay が
  // 400 INTENT_NOT_REUSABLE（非対象）で自己終息する。
  if (res.status >= 500 && res.status <= 599) {
    return { kind: "replayable", retryAfterMs: null, message };
  }

  if (res.status === 429) {
    return { kind: "replayable", retryAfterMs: parseRetryAfterMs(res.headers.get("Retry-After")), message };
  }

  if (res.status === 409 && envelope !== null && RETRYABLE_FINALIZE_409_CODES.has(envelope.code)) {
    return { kind: "replayable", retryAfterMs: null, message };
  }

  // 400 全種 / 401 / 403 / 404 / 413 / 415 / 409 OBJECT_MISSING ほか → 固定 error。
  // replay も legacy fallback も新 intent も行わない（business retry = 再ドロップ）。
  return { kind: "fatal", message };
}

// 同一 intentId の bounded replay。停止条件: 成功 / fatal / delays 消費
// （= REPLAY_EXHAUSTED → 既存 error 表示）。この loop は intentId を変更せず、
// Prepare 再送・legacy fallback・upload 再送のいずれも行わない。
async function finalizeWithBoundedReplay(
  intentId: string,
): Promise<{ item: Record<string, unknown>; signedUrls: SignedUrls }> {
  for (let attempt = 0; ; attempt++) {
    const outcome = await finalizeOnce(intentId);
    if (outcome.kind === "success") return { item: outcome.item, signedUrls: outcome.signedUrls };
    if (outcome.kind === "fatal") throw new Error(outcome.message);
    if (attempt >= DIRECT_FINALIZE_REPLAY_DELAYS_MS.length) {
      // REPLAY_EXHAUSTED: 以後の network I/O はゼロ。回復はユーザーの再ドロップ。
      throw new Error(outcome.message);
    }
    const base = DIRECT_FINALIZE_REPLAY_DELAYS_MS[attempt];
    // 429 のみ Retry-After（60 秒 cap 済み）を尊重し max(Retry-After, base) 待つ。
    // 最悪総待機 = 60+60+60+90 = 270 秒（有界）。
    const waitMs = outcome.retryAfterMs !== null ? Math.max(outcome.retryAfterMs, base) : base;
    await sleep(waitMs);
  }
}

// ---------------------------------------------------------------------------
// Direct Upload orchestrator（既存 uploadFile と同一契約）
// ---------------------------------------------------------------------------

export async function uploadFileDirect(
  file: File,
  sessionId: string,
  onProgress: (p: UploadProgress) => void,
): Promise<UploadResult> {
  onProgress({ stage: "hashing" });
  const clientFileHash = await sha256Hex(file);

  // legacy と同じ生成器で local preview のみ作る（Storage へは送らない —
  // thumbnail / preview variant は Finalize が server 実測から生成する）。
  onProgress({ stage: "compressing" });
  const previewBlob = await generateWebpBlob(file, 800, 0.9);
  const previewObjectUrl = previewBlob ? URL.createObjectURL(previewBlob) : null;
  const revokePreview = () => {
    if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
  };

  onProgress({ stage: "uploading" });

  // clientUploadId は operation 開始時に 1 回だけ生成（server 側 idempotency key）。
  const clientUploadId = crypto.randomUUID();

  // ---- Prepare（exact-key body。width/height は送らない — server 実測が正本） --
  let prepareRes: Response;
  try {
    prepareRes = await fetch("/api/uploads/items/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        clientUploadId,
        originalName: file.name,
        declaredSizeBytes: file.size,
        declaredMimeType: file.type,
        clientFileHash,
      }),
    });
  } catch (e) {
    // Prepare の network 失敗: intent が作成済みの可能性があるため fallback は
    // error masking になる — legacy へは倒さず error（残骸は sweep 回収）。
    revokePreview();
    throw new Error(errorMessageOf(e));
  }

  if (!prepareRes.ok) {
    const envelope = await readErrorEnvelope(prepareRes);
    if (
      prepareRes.status === 404 &&
      envelope !== null &&
      envelope.code === "NOT_FOUND" &&
      envelope.message === "Not found"
    ) {
      // exact gate-404（auth 前・intent 未作成・副作用ゼロ）のみ legacy へ
      // 1 回だけ委譲する。以後 Direct 経路（signed upload / Finalize）は呼ばない。
      revokePreview();
      return uploadFile(file, sessionId, onProgress);
    }
    // gate 以外の全 error（session 404 / 401 / 403 / 409 / 413 / 415 / 429 / 5xx）
    // は fallback せず error 表示（Plan §47 行 3）。
    revokePreview();
    throw new Error(envelope?.message ?? `Upload failed: ${prepareRes.status}`);
  }

  let intentId: string;
  let upload: { bucket: string; path: string; token: string } | null;
  try {
    const json = (await prepareRes.json()) as {
      data?: {
        intentId?: unknown;
        alreadyFinalized?: unknown;
        upload?: { bucket?: unknown; path?: unknown; token?: unknown };
      };
    };
    const data = json?.data;
    if (!data || typeof data.intentId !== "string") throw new Error("Upload failed");
    intentId = data.intentId;
    const u = data.upload;
    upload =
      data.alreadyFinalized !== true &&
      u &&
      typeof u.bucket === "string" &&
      typeof u.path === "string" &&
      typeof u.token === "string"
        ? { bucket: u.bucket, path: u.path, token: u.token }
        : null;
    if (data.alreadyFinalized !== true && upload === null) throw new Error("Upload failed");
  } catch (e) {
    // Prepare 成功 status で body 欠損。ここで新 Prepare は発行しない（Plan に
    // ない自動 retry loop を作らない）— error 表示、残骸 intent は sweep 回収。
    revokePreview();
    throw new Error(errorMessageOf(e));
  }

  // ---- Signed upload（path / token は Prepare 応答値のみ。1 operation 最大 1 回） --
  if (upload !== null) {
    try {
      const supabase = createClient();
      await supabase.storage.from(upload.bucket).uploadToSignedUrl(upload.path, upload.token, file);
      // {error} が返っても throw されても扱いは同一: bytes が Storage へ到達した
      // かは client から確定できないため、成功/失敗を問わず同一 intentId の
      // Finalize（下）が server 実測で照合する（Finalize-probe / UPLOAD_RECONCILING）。
      // upload の再送・新 Prepare・legacy fallback はいかなる失敗でも行わない。
    } catch {
      // 非 StorageError throw（network / CORS / 送信前失敗）も同じ扱い。
    }
  }

  // ---- Finalize（同一 intentId・bounded replay。probe は attempt #1 を兼ねる） --
  let finalized: { item: Record<string, unknown>; signedUrls: SignedUrls };
  try {
    finalized = await finalizeWithBoundedReplay(intentId);
  } catch (e) {
    revokePreview();
    throw e;
  }

  onProgress({ stage: "done" });
  return { item: finalized.item, signedUrls: finalized.signedUrls, previewObjectUrl };
}

// ---------------------------------------------------------------------------
// Upload 関数の選択（QuickAddClient wiring 用・排他）
// ---------------------------------------------------------------------------

// flag は server（page.tsx の Server Component）が読んで boolean prop として
// 渡す。この選択は operation 途中で切り替わらない（QuickAddClient 側は ref に
// 固定して使う）。false = 既存 legacy uploadFile のみ / true = Direct のみ。
export function selectUploadFileFn(directUploadEnabled: boolean): typeof uploadFile {
  return directUploadEnabled ? uploadFileDirect : uploadFile;
}
