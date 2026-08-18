// Phase 10-43-B4: directUploadClient（Direct Upload orchestrator）の unit /
// wiring contract test。fetch / Storage SDK / legacy uploadFile / hash /
// preview 生成は module mock、replay の delay sequence は fake timer で
// 決定的に固定する。expected 値は literal で保持する（Production 定数を
// expected oracle として循環利用しない）。唯一の例外は lease invariant test
// で、server 定数 FINALIZE_LEASE_MS を test からのみ import して
// sum(delays) > lease を固定する（Production module は import しない）。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FINALIZE_LEASE_MS } from "./uploadIntentCore";

// ---------------------------------------------------------------------------
// module mocks（vi.mock は hoist されるため vi.hoisted で共有 fn を作る）
// ---------------------------------------------------------------------------

const { uploadFileMock, sha256HexMock, generateWebpBlobMock, uploadToSignedUrlMock, storageFromMock } =
  vi.hoisted(() => ({
    uploadFileMock: vi.fn(),
    sha256HexMock: vi.fn(),
    generateWebpBlobMock: vi.fn(),
    uploadToSignedUrlMock: vi.fn(),
    storageFromMock: vi.fn(),
  }));

vi.mock("./uploadClient", () => ({ uploadFile: uploadFileMock }));
vi.mock("./hashClient", () => ({ sha256Hex: sha256HexMock }));
vi.mock("./thumbnailClient", () => ({ generateWebpBlob: generateWebpBlobMock }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ storage: { from: storageFromMock } }),
}));

import {
  uploadFileDirect,
  selectUploadFileFn,
  DIRECT_FINALIZE_REPLAY_DELAYS_MS,
} from "./directUploadClient";

// ---------------------------------------------------------------------------
// fetch stub（prepare / finalize を URL で routing し、呼出を記録する）
// ---------------------------------------------------------------------------

type QueueEntry = Response | Error;
const prepareQueue: QueueEntry[] = [];
const finalizeQueue: QueueEntry[] = [];
const prepareCalls: Array<Record<string, unknown>> = [];
const finalizeCalls: Array<Record<string, unknown>> = [];

const fetchMock = vi.fn(async (url: unknown, init?: { body?: unknown }): Promise<Response> => {
  const u = String(url);
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  if (u.includes("/api/uploads/items/prepare")) {
    prepareCalls.push(body);
    const next = prepareQueue.shift();
    if (!next) throw new Error("test setup: unexpected prepare call");
    if (next instanceof Error) throw next;
    return next;
  }
  if (u.includes("/api/uploads/items/finalize")) {
    finalizeCalls.push(body);
    const next = finalizeQueue.shift();
    if (!next) throw new Error("test setup: unexpected finalize call");
    if (next instanceof Error) throw next;
    return next;
  }
  throw new Error(`test setup: unexpected fetch url ${u}`);
});
vi.stubGlobal("fetch", fetchMock);

// ---------------------------------------------------------------------------
// fixtures / builders（expected は literal）
// ---------------------------------------------------------------------------

const HASH = "a".repeat(64);
const INTENT_ID = "intent_fixture_1";
// token / path は「絶対に露出してはならない値」として検出可能な canary literal。
const SECRET_TOKEN = "SECRET_SIGNED_TOKEN_canary";
const SECRET_PATH = "wsx/upload-intents/sess_1/intent_fixture_1/original";
const ITEM = { id: "item_fixture_1", uploadStatus: "READY", sortOrder: 3 };
const SIGNED_URLS = {
  thumbnail: { signedUrl: "https://signed.example.test/t", fallback: false },
  preview: { signedUrl: "https://signed.example.test/p", fallback: false },
  original: { signedUrl: "https://signed.example.test/o", fallback: false },
};

const JSON_CT = { "content-type": "application/json" };

function jsonRes(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_CT, ...headers } });
}

function preparedRes(status: 200 | 201 = 201): Response {
  return jsonRes(status, {
    data: {
      intentId: INTENT_ID,
      reservedUploadItemId: "rui_1",
      reservedSortOrder: 3,
      alreadyFinalized: false,
      upload: {
        bucket: "photobox-private",
        path: SECRET_PATH,
        token: SECRET_TOKEN,
        expiresAt: "2026-01-01T00:00:00.000Z",
      },
    },
  });
}

function finalizeOkRes(status: 200 | 201 = 201): Response {
  return jsonRes(status, { data: { item: ITEM, signedUrls: SIGNED_URLS } });
}

function errRes(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return jsonRes(status, { error: { code, message } }, headers);
}

const gate404 = () => errRes(404, "NOT_FOUND", "Not found");

function makeFile(): File {
  return new File([new Uint8Array([1, 2, 3])], "photo.jpg", { type: "image/jpeg" });
}

function start(file: File = makeFile()) {
  const stages: string[] = [];
  const onProgress = vi.fn((p: { stage: string }) => stages.push(p.stage));
  const promise = uploadFileDirect(file, "sess_1", onProgress);
  return { file, stages, onProgress, promise };
}

// promise を先に settle 捕捉しておき、fake timer 進行後に検査する。
function capture<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
}

beforeEach(() => {
  prepareQueue.length = 0;
  finalizeQueue.length = 0;
  prepareCalls.length = 0;
  finalizeCalls.length = 0;
  fetchMock.mockClear();
  uploadFileMock.mockReset();
  sha256HexMock.mockReset().mockResolvedValue(HASH);
  // preview blob null（node 環境に URL.createObjectURL がないため）— previewObjectUrl null 経路
  generateWebpBlobMock.mockReset().mockResolvedValue(null);
  uploadToSignedUrlMock.mockReset().mockResolvedValue({ data: { path: SECRET_PATH }, error: null });
  storageFromMock.mockReset().mockImplementation(() => ({ uploadToSignedUrl: uploadToSignedUrlMock }));
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

describe("public contract", () => {
  it("1-2) 既存uploadFileと同一signatureで呼べ、同一UploadResult shapeを返す", async () => {
    prepareQueue.push(preparedRes());
    finalizeQueue.push(finalizeOkRes(201));
    const { promise } = start();
    const result = await promise;
    expect(Object.keys(result).sort()).toEqual(["item", "previewObjectUrl", "signedUrls"]);
    expect(result.item).toEqual(ITEM);
    expect(result.signedUrls).toEqual(SIGNED_URLS);
    expect(result.previewObjectUrl).toBeNull();
  });

  it("3) original File bytesをそのままsigned uploadへ渡す（thumb/preview blobは送らない）", async () => {
    prepareQueue.push(preparedRes());
    finalizeQueue.push(finalizeOkRes());
    const { file, promise } = start();
    await promise;
    expect(uploadToSignedUrlMock).toHaveBeenCalledTimes(1);
    expect(uploadToSignedUrlMock.mock.calls[0][2]).toBe(file);
  });

  it("4-5) path / token / bucketはPrepare responseの値だけを使用（client生成なし）", async () => {
    prepareQueue.push(preparedRes());
    finalizeQueue.push(finalizeOkRes());
    const { promise } = start();
    await promise;
    expect(storageFromMock).toHaveBeenCalledWith("photobox-private");
    expect(uploadToSignedUrlMock.mock.calls[0][0]).toBe(SECRET_PATH);
    expect(uploadToSignedUrlMock.mock.calls[0][1]).toBe(SECRET_TOKEN);
  });

  it("6) token / path / expiresAtをresultへ含めない", async () => {
    prepareQueue.push(preparedRes());
    finalizeQueue.push(finalizeOkRes());
    const { promise } = start();
    const result = await promise;
    const text = JSON.stringify(result);
    expect(text).not.toContain(SECRET_TOKEN);
    expect(text).not.toContain(SECRET_PATH);
    expect(text).not.toContain("expiresAt");
  });

  it("成功時のstage列は既存語彙のみ（hashing→compressing→uploading→done）", async () => {
    prepareQueue.push(preparedRes());
    finalizeQueue.push(finalizeOkRes());
    const { stages, promise } = start();
    await promise;
    expect(stages).toEqual(["hashing", "compressing", "uploading", "done"]);
  });
});

// ---------------------------------------------------------------------------
// Flag / fallback
// ---------------------------------------------------------------------------

describe("flag wiring / gate-404 fallback", () => {
  it("7-8) selectUploadFileFn: false=legacyのみ / true=Directのみ（排他）", () => {
    expect(selectUploadFileFn(false)).toBe(uploadFileMock);
    expect(selectUploadFileFn(true)).toBe(uploadFileDirect);
    expect(selectUploadFileFn(false)).not.toBe(uploadFileDirect);
    expect(selectUploadFileFn(true)).not.toBe(uploadFileMock);
  });

  it("9,15,59) exact gate-404はlegacyへ厳密に1回fallback（同一引数）・signed upload 0・Finalize 0", async () => {
    prepareQueue.push(gate404());
    const sentinel = { item: { id: "legacy_item" }, signedUrls: SIGNED_URLS, previewObjectUrl: null };
    uploadFileMock.mockResolvedValue(sentinel);
    const { file, onProgress, promise } = start(makeFile());
    const result = await promise;
    expect(result).toBe(sentinel);
    expect(uploadFileMock).toHaveBeenCalledTimes(1);
    expect(uploadFileMock).toHaveBeenCalledWith(file, "sess_1", onProgress);
    expect(uploadToSignedUrlMock).toHaveBeenCalledTimes(0);
    expect(finalizeCalls).toHaveLength(0);
  });

  it("10) statusだけ404（message違い: session 404）ではfallbackしない", async () => {
    prepareQueue.push(errRes(404, "NOT_FOUND", "Session not found"));
    const { promise } = start();
    await expect(promise).rejects.toThrow("Session not found");
    expect(uploadFileMock).toHaveBeenCalledTimes(0);
  });

  it("11) JSONでない404はfallbackしない", async () => {
    prepareQueue.push(new Response("<html>404</html>", { status: 404, headers: { "content-type": "text/html" } }));
    const { promise } = start();
    await expect(promise).rejects.toThrow("Upload failed: 404");
    expect(uploadFileMock).toHaveBeenCalledTimes(0);
  });

  it("12) code違いの404はfallbackしない", async () => {
    prepareQueue.push(errRes(404, "VALIDATION_ERROR", "Not found"));
    const { promise } = start();
    await expect(promise).rejects.toThrow("Not found");
    expect(uploadFileMock).toHaveBeenCalledTimes(0);
  });

  it("13) Prepare network failureではfallbackしない（error表示・Prepare再送もしない）", async () => {
    prepareQueue.push(new TypeError("Failed to fetch"));
    const { promise } = start();
    await expect(promise).rejects.toThrow("Failed to fetch");
    expect(uploadFileMock).toHaveBeenCalledTimes(0);
    expect(prepareCalls).toHaveLength(1);
    expect(finalizeCalls).toHaveLength(0);
  });

  it("14) Prepare 401/403/429/500ではfallbackせずerror（envelope message表示・retryなし）", async () => {
    const cases: Array<[number, string, string]> = [
      [401, "UNAUTHORIZED", "Authentication required"],
      [403, "FORBIDDEN", "Access denied"],
      [429, "RATE_LIMITED", "Too many requests. Please try again later."],
      [500, "SIGNED_UPLOAD_URL_ISSUE_FAILED", "Failed to issue a signed upload token. Please retry."],
    ];
    for (const [status, code, message] of cases) {
      prepareCalls.length = 0;
      prepareQueue.push(errRes(status, code, message));
      const { promise } = start();
      await expect(promise).rejects.toThrow(message);
      expect(uploadFileMock).toHaveBeenCalledTimes(0);
      expect(uploadToSignedUrlMock).toHaveBeenCalledTimes(0);
      expect(prepareCalls).toHaveLength(1); // Prepare自動retry loopなし
    }
  });
});

// ---------------------------------------------------------------------------
// Prepare request
// ---------------------------------------------------------------------------

describe("prepare request contract", () => {
  it("16) exact-key body（6キーのみ・width/heightなし・値も正確）", async () => {
    prepareQueue.push(preparedRes());
    finalizeQueue.push(finalizeOkRes());
    const { promise } = start();
    await promise;
    const body = prepareCalls[0];
    expect(Object.keys(body).sort()).toEqual([
      "clientFileHash",
      "clientUploadId",
      "declaredMimeType",
      "declaredSizeBytes",
      "originalName",
      "sessionId",
    ]);
    expect(body.sessionId).toBe("sess_1");
    expect(body.originalName).toBe("photo.jpg");
    expect(body.declaredSizeBytes).toBe(3);
    expect(body.declaredMimeType).toBe("image/jpeg");
    expect(body.clientFileHash).toBe(HASH);
    expect(body.clientUploadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("17,53) clientUploadIdはoperation毎に新規・operation内でPrepareは1回のみ", async () => {
    prepareQueue.push(preparedRes());
    finalizeQueue.push(finalizeOkRes());
    await start().promise;
    prepareQueue.push(preparedRes());
    finalizeQueue.push(finalizeOkRes());
    await start().promise;
    expect(prepareCalls).toHaveLength(2);
    expect(prepareCalls[0].clientUploadId).not.toBe(prepareCalls[1].clientUploadId);
  });

  it("18-19) Prepare成功後はlegacy 0・new Prepare 0（Finalize fatalでも）", async () => {
    prepareQueue.push(preparedRes());
    finalizeQueue.push(errRes(400, "INTENT_EXPIRED", "This upload intent has expired. Start a new upload."));
    const { promise } = start();
    await expect(promise).rejects.toThrow("This upload intent has expired");
    expect(uploadFileMock).toHaveBeenCalledTimes(0);
    expect(prepareCalls).toHaveLength(1);
  });

  it("20) Prepare失敗のerrorへtoken/pathを含めない（envelope固定文のみ）", async () => {
    prepareQueue.push(errRes(409, "IDEMPOTENCY_CONFLICT", "clientUploadId was already used with a different request payload."));
    const { promise } = start();
    const settled = await capture(promise);
    expect(settled.ok).toBe(false);
    const text = String((settled as { error: unknown }).error) + JSON.stringify((settled as { error: unknown }).error);
    expect(text).not.toContain(SECRET_TOKEN);
    expect(text).not.toContain(SECRET_PATH);
  });

  it("alreadyFinalized=trueのPrepare応答はuploadをskipし同一intentIdでFinalize（replay 200収束）", async () => {
    prepareQueue.push(jsonRes(200, { data: { intentId: INTENT_ID, reservedUploadItemId: "rui_1", reservedSortOrder: 3, alreadyFinalized: true, uploadItemId: "item_fixture_1" } }));
    finalizeQueue.push(finalizeOkRes(200));
    const { promise } = start();
    const result = await promise;
    expect(result.item).toEqual(ITEM);
    expect(uploadToSignedUrlMock).toHaveBeenCalledTimes(0);
    expect(finalizeCalls).toEqual([{ intentId: INTENT_ID }]);
  });
});

// ---------------------------------------------------------------------------
// Signed upload reconciliation
// ---------------------------------------------------------------------------

describe("signed upload reconciliation（Finalize-probe）", () => {
  it("21) SDK成功→同一intentIdでFinalize 1回", async () => {
    prepareQueue.push(preparedRes());
    finalizeQueue.push(finalizeOkRes());
    await start().promise;
    expect(finalizeCalls).toEqual([{ intentId: INTENT_ID }]);
  });

  it("22) SDK throw（非StorageError）→same-intent Finalize probe→成功収束", async () => {
    uploadToSignedUrlMock.mockRejectedValue(new Error("network down mid-flight"));
    prepareQueue.push(preparedRes());
    finalizeQueue.push(finalizeOkRes(201));
    const result = await start().promise;
    expect(result.item).toEqual(ITEM);
    expect(finalizeCalls).toEqual([{ intentId: INTENT_ID }]);
  });

  it("23,27) SDK response loss相当（error返却）→probe 200で成功収束", async () => {
    uploadToSignedUrlMock.mockResolvedValue({ data: null, error: { name: "StorageUnknownError", message: "fetch failed" } });
    prepareQueue.push(preparedRes());
    finalizeQueue.push(finalizeOkRes(200));
    const result = await start().promise;
    expect(result.item).toEqual(ITEM);
    expect(finalizeCalls).toEqual([{ intentId: INTENT_ID }]);
  });

  it("28) probe 201（bytes到達済みだった）も成功", async () => {
    uploadToSignedUrlMock.mockResolvedValue({ data: null, error: { name: "StorageApiError", status: 409, statusCode: "Duplicate", message: "The resource already exists" } });
    prepareQueue.push(preparedRes());
    finalizeQueue.push(finalizeOkRes(201));
    const result = await start().promise;
    expect(result.item).toEqual(ITEM);
  });

  it("24-26) ambiguous failure後: signed upload再送0・legacy 0・new Prepare 0", async () => {
    uploadToSignedUrlMock.mockRejectedValue(new Error("connection reset"));
    prepareQueue.push(preparedRes());
    finalizeQueue.push(finalizeOkRes());
    await start().promise;
    expect(uploadToSignedUrlMock).toHaveBeenCalledTimes(1);
    expect(uploadFileMock).toHaveBeenCalledTimes(0);
    expect(prepareCalls).toHaveLength(1);
  });

  it("29) probe OBJECT_MISSINGは固定error・replay 0・fallback 0", async () => {
    uploadToSignedUrlMock.mockRejectedValue(new Error("aborted"));
    prepareQueue.push(preparedRes());
    finalizeQueue.push(errRes(409, "OBJECT_MISSING", "Upload the file to storage before finalizing."));
    const { promise } = start();
    await expect(promise).rejects.toThrow("Upload the file to storage before finalizing.");
    expect(finalizeCalls).toHaveLength(1);
    expect(uploadToSignedUrlMock).toHaveBeenCalledTimes(1);
    expect(uploadFileMock).toHaveBeenCalledTimes(0);
    expect(prepareCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Finalize bounded replay（fake timer）
// ---------------------------------------------------------------------------

describe("finalize bounded replay", () => {
  it("30,39) network response loss→+5秒後にsame intentでreplayし成功", async () => {
    vi.useFakeTimers();
    prepareQueue.push(preparedRes());
    finalizeQueue.push(new TypeError("Failed to fetch"));
    finalizeQueue.push(finalizeOkRes(200));
    const settled = capture(start().promise);
    await vi.advanceTimersByTimeAsync(0);
    expect(finalizeCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(finalizeCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const result = await settled;
    expect(result.ok).toBe(true);
    expect(finalizeCalls).toEqual([{ intentId: INTENT_ID }, { intentId: INTENT_ID }]);
  });

  it("31) 500 transient→same intent replayで成功", async () => {
    vi.useFakeTimers();
    prepareQueue.push(preparedRes());
    finalizeQueue.push(errRes(500, "INTERNAL_ERROR", "Failed to finalize the upload. Please retry."));
    finalizeQueue.push(finalizeOkRes(201));
    const settled = capture(start().promise);
    await vi.runAllTimersAsync();
    expect((await settled).ok).toBe(true);
    expect(finalizeCalls).toEqual([{ intentId: INTENT_ID }, { intentId: INTENT_ID }]);
  });

  it("32) FINALIZE_IN_PROGRESS→wait→same intent", async () => {
    vi.useFakeTimers();
    prepareQueue.push(preparedRes());
    finalizeQueue.push(errRes(409, "FINALIZE_IN_PROGRESS", "This upload is being finalized. Please retry shortly."));
    finalizeQueue.push(finalizeOkRes(200));
    const settled = capture(start().promise);
    await vi.runAllTimersAsync();
    expect((await settled).ok).toBe(true);
    expect(finalizeCalls).toEqual([{ intentId: INTENT_ID }, { intentId: INTENT_ID }]);
  });

  it("33) retryable cleanup conflict code（SESSION/INTENT_CLEANUP_IN_PROGRESS・CONFLICT）→same intent", async () => {
    for (const code of ["SESSION_CLEANUP_IN_PROGRESS", "INTENT_CLEANUP_IN_PROGRESS", "CONFLICT"]) {
      finalizeCalls.length = 0;
      vi.useFakeTimers();
      prepareQueue.push(preparedRes());
      finalizeQueue.push(errRes(409, code, "Please retry."));
      finalizeQueue.push(finalizeOkRes(200));
      const settled = capture(start().promise);
      await vi.runAllTimersAsync();
      expect((await settled).ok).toBe(true);
      expect(finalizeCalls).toEqual([{ intentId: INTENT_ID }, { intentId: INTENT_ID }]);
      vi.useRealTimers();
    }
  });

  it("34) 429はmax(Retry-After, base delay)=60秒待ってからsame intent", async () => {
    vi.useFakeTimers();
    prepareQueue.push(preparedRes());
    finalizeQueue.push(errRes(429, "RATE_LIMITED", "Too many requests. Please try again later.", { "Retry-After": "60" }));
    finalizeQueue.push(finalizeOkRes(200));
    const settled = capture(start().promise);
    await vi.advanceTimersByTimeAsync(0);
    expect(finalizeCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(finalizeCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await settled).ok).toBe(true);
    expect(finalizeCalls).toHaveLength(2);
  });

  it("35) invalid Retry-Afterは無視してbase delay（5秒）", async () => {
    vi.useFakeTimers();
    prepareQueue.push(preparedRes());
    finalizeQueue.push(errRes(429, "RATE_LIMITED", "Too many requests. Please try again later.", { "Retry-After": "soon" }));
    finalizeQueue.push(finalizeOkRes(200));
    const settled = capture(start().promise);
    await vi.advanceTimersByTimeAsync(0);
    expect(finalizeCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(finalizeCalls).toHaveLength(2);
    expect((await settled).ok).toBe(true);
  });

  it("36) fatal 400（VALIDATION/INTENT_NOT_REUSABLE）はreplay 0・timerなし", async () => {
    prepareQueue.push(preparedRes());
    finalizeQueue.push(errRes(400, "INTENT_NOT_REUSABLE", "This upload intent can no longer be used. Start a new upload."));
    const { promise } = start();
    await expect(promise).rejects.toThrow("This upload intent can no longer be used");
    expect(finalizeCalls).toHaveLength(1);
  });

  it("37) 401/403/404/413/415はreplay 0", async () => {
    const cases: Array<[number, string, string]> = [
      [401, "UNAUTHORIZED", "Authentication required"],
      [403, "FORBIDDEN", "Access denied"],
      [404, "NOT_FOUND", "Not found"], // 進行中flag OFF: Finalize gate 404もfallbackせずerror
      [413, "PAYLOAD_TOO_LARGE", "The uploaded file exceeds the size limit."],
      [415, "UNSUPPORTED_MEDIA_TYPE", "The uploaded file is not a supported image format."],
    ];
    for (const [status, code, message] of cases) {
      finalizeCalls.length = 0;
      prepareQueue.push(preparedRes());
      finalizeQueue.push(errRes(status, code, message));
      const { promise } = start();
      await expect(promise).rejects.toThrow(message);
      expect(finalizeCalls).toHaveLength(1);
      expect(uploadFileMock).toHaveBeenCalledTimes(0);
    }
  });

  it("38) OBJECT_MISSINGはreplay 0（upload成功報告後でも固定error）", async () => {
    prepareQueue.push(preparedRes());
    finalizeQueue.push(errRes(409, "OBJECT_MISSING", "Upload the file to storage before finalizing."));
    const { promise } = start();
    await expect(promise).rejects.toThrow("Upload the file to storage before finalizing.");
    expect(finalizeCalls).toHaveLength(1);
  });

  it("40-41) delay sequenceは[5000,15000,45000,90000]・最大5 request・exhaustionでerror", async () => {
    vi.useFakeTimers();
    prepareQueue.push(preparedRes());
    for (let i = 0; i < 5; i++) {
      finalizeQueue.push(errRes(500, "INTERNAL_ERROR", "Failed to finalize the upload. Please retry."));
    }
    const settled = capture(start().promise);
    await vi.advanceTimersByTimeAsync(0);
    expect(finalizeCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(finalizeCalls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(finalizeCalls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(finalizeCalls).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(finalizeCalls).toHaveLength(5);
    const result = await settled;
    expect(result.ok).toBe(false);
    expect(String((result as { error: unknown }).error)).toContain("Failed to finalize the upload. Please retry.");
  });

  it("42-45,55) exhaustion後: 固定error・legacy 0・new Prepare 0・upload再送0・追加callbackなし", async () => {
    vi.useFakeTimers();
    prepareQueue.push(preparedRes());
    for (let i = 0; i < 5; i++) finalizeQueue.push(new TypeError("Failed to fetch"));
    const { stages, promise } = start();
    const settled = capture(promise);
    await vi.runAllTimersAsync();
    const result = await settled;
    expect(result.ok).toBe(false);
    expect(finalizeCalls).toHaveLength(5);
    expect(uploadFileMock).toHaveBeenCalledTimes(0);
    expect(prepareCalls).toHaveLength(1);
    expect(uploadToSignedUrlMock).toHaveBeenCalledTimes(1);
    // settle後にtimer/network/callbackが残らない（unmount安全）
    const stagesAfterSettle = stages.length;
    const finalizeAfterSettle = finalizeCalls.length;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(stages.length).toBe(stagesAfterSettle);
    expect(stages).not.toContain("done");
    expect(finalizeCalls.length).toBe(finalizeAfterSettle);
  });

  it("50-51) replay中もintentId不変・new intent 0・legacy 0（混合エラー列）", async () => {
    vi.useFakeTimers();
    prepareQueue.push(preparedRes());
    finalizeQueue.push(new TypeError("Failed to fetch"));
    finalizeQueue.push(errRes(500, "INTERNAL_ERROR", "Failed to finalize the upload. Please retry."));
    finalizeQueue.push(errRes(409, "FINALIZE_IN_PROGRESS", "This upload is being finalized. Please retry shortly."));
    finalizeQueue.push(finalizeOkRes(200));
    const settled = capture(start().promise);
    await vi.runAllTimersAsync();
    expect((await settled).ok).toBe(true);
    expect(finalizeCalls).toHaveLength(4);
    for (const call of finalizeCalls) expect(call).toEqual({ intentId: INTENT_ID });
    expect(prepareCalls).toHaveLength(1);
    expect(uploadFileMock).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// Lease invariant / rate limit
// ---------------------------------------------------------------------------

describe("lease invariant / rate limit構造", () => {
  it("46) sum(delays) > FINALIZE_LEASE_MS（155000 > 120000）", () => {
    const sum = DIRECT_FINALIZE_REPLAY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(sum).toBe(155_000);
    expect(FINALIZE_LEASE_MS).toBe(120_000);
    expect(sum).toBeGreaterThan(FINALIZE_LEASE_MS);
  });

  it("delay sequenceはexact literal [5000,15000,45000,90000]（最大5 request）", () => {
    expect([...DIRECT_FINALIZE_REPLAY_DELAYS_MS]).toEqual([5_000, 15_000, 45_000, 90_000]);
    expect(1 + DIRECT_FINALIZE_REPLAY_DELAYS_MS.length).toBe(5);
  });

  it("47) concurrency 2 × 最大5 request = 10 ≤ 60/1m（rate limit上限内の構造）", () => {
    const maxRequestsPerFile = 1 + DIRECT_FINALIZE_REPLAY_DELAYS_MS.length;
    const maxConcurrent = 2; // QuickAddClient MAX_CONCURRENT（下のstatic testで2を固定）
    expect(maxRequestsPerFile * maxConcurrent).toBeLessThanOrEqual(60);
  });

  it("48,52) unbounded loopなし: 常時replayable errorでも総Finalize request=5で停止・operation内Prepare 1/upload 1", async () => {
    vi.useFakeTimers();
    prepareQueue.push(preparedRes());
    for (let i = 0; i < 5; i++) {
      finalizeQueue.push(errRes(429, "RATE_LIMITED", "Too many requests. Please try again later.", { "Retry-After": "60" }));
    }
    const settled = capture(start().promise);
    await vi.runAllTimersAsync();
    expect((await settled).ok).toBe(false);
    expect(finalizeCalls).toHaveLength(5);
    expect(prepareCalls).toHaveLength(1);
    expect(uploadToSignedUrlMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Focused remediation（Fix A: Retry-After cap / Fix B: 5xx replay / Fix C: settle後timer）
// ---------------------------------------------------------------------------

describe("Fix A: Retry-After 60秒cap", () => {
  // [header値, 期待待機ms]。cap=60秒、base delay(attempt 0)=5秒。
  const matrix: Array<[string, number]> = [
    ["1", 5_000], // max(1s, base 5s) = base
    ["60", 60_000],
    ["61", 60_000], // cap
    ["3600", 60_000], // cap
    ["999999", 60_000], // cap
    ["0", 5_000], // invalid（1未満）→ base
    ["-1", 5_000], // invalid → base
    ["1.5", 5_000], // invalid（小数）→ base
    ["1e2", 5_000], // invalid（指数表記）→ base
    ["   ", 5_000], // invalid（空白のみ）→ base
    ["Wed, 21 Oct 2026 07:28:00 GMT", 5_000], // invalid（HTTP-date）→ base
    ["invalid", 5_000], // invalid → base
    ["99999999999999999999", 5_000], // invalid（safe integer超過）→ base
  ];
  for (const [header, expectedWaitMs] of matrix) {
    it(`Retry-After "${header}" → 実待機 ${expectedWaitMs}ms`, async () => {
      vi.useFakeTimers();
      prepareQueue.push(preparedRes());
      finalizeQueue.push(errRes(429, "RATE_LIMITED", "Too many requests. Please try again later.", { "Retry-After": header }));
      finalizeQueue.push(finalizeOkRes(200));
      const settled = capture(start().promise);
      await vi.advanceTimersByTimeAsync(0);
      expect(finalizeCalls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(expectedWaitMs - 1);
      expect(finalizeCalls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(finalizeCalls).toHaveLength(2);
      expect((await settled).ok).toBe(true);
    });
  }

  it("最悪総待機: 429×5（巨大Retry-After）でも累計270,000msで停止・request 5・settle後timer 0", async () => {
    vi.useFakeTimers();
    prepareQueue.push(preparedRes());
    for (let i = 0; i < 5; i++) {
      finalizeQueue.push(errRes(429, "RATE_LIMITED", "Too many requests. Please try again later.", { "Retry-After": "3600" }));
    }
    const settled = capture(start().promise);
    await vi.advanceTimersByTimeAsync(0);
    expect(finalizeCalls).toHaveLength(1);
    // 待機列 = max(cap60s, base): 60s / 60s / 60s / 90s（累計270s）
    await vi.advanceTimersByTimeAsync(60_000);
    expect(finalizeCalls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(finalizeCalls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(finalizeCalls).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(finalizeCalls).toHaveLength(5);
    const result = await settled;
    expect(result.ok).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(finalizeCalls).toHaveLength(5); // 6回目なし
    expect(uploadFileMock).toHaveBeenCalledTimes(0);
    expect(prepareCalls).toHaveLength(1);
    expect(uploadToSignedUrlMock).toHaveBeenCalledTimes(1);
  });
});

describe("Fix B: HTTP 5xx全体をsame-intent replay対象", () => {
  it("502/503/504/599（非JSON body含む）→ same intentでreplayし成功・fallback 0", async () => {
    for (const status of [502, 503, 504, 599]) {
      finalizeCalls.length = 0;
      prepareCalls.length = 0;
      uploadToSignedUrlMock.mockClear();
      vi.useFakeTimers();
      prepareQueue.push(preparedRes());
      finalizeQueue.push(new Response("<html>gateway error</html>", { status, headers: { "content-type": "text/html" } }));
      finalizeQueue.push(finalizeOkRes(200));
      const settled = capture(start().promise);
      await vi.runAllTimersAsync();
      expect((await settled).ok).toBe(true);
      expect(finalizeCalls).toEqual([{ intentId: INTENT_ID }, { intentId: INTENT_ID }]);
      expect(uploadFileMock).toHaveBeenCalledTimes(0);
      expect(prepareCalls).toHaveLength(1);
      expect(uploadToSignedUrlMock).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    }
  });

  it("境界: 499はfatal（replay 0）", async () => {
    prepareQueue.push(preparedRes());
    finalizeQueue.push(errRes(499, "RATE_LIMITED", "client closed request"));
    const { promise } = start();
    await expect(promise).rejects.toThrow("client closed request");
    expect(finalizeCalls).toHaveLength(1);
    expect(uploadFileMock).toHaveBeenCalledTimes(0);
  });

  it("境界: 600はfatal（replay 0）", async () => {
    prepareQueue.push(preparedRes());
    // Response constructorは600を許さないため、finalizeOnceが参照する最小界面
    // （ok/status/headers/json）だけを持つ疑似responseを注入する。
    const fake600 = {
      ok: false,
      status: 600,
      headers: new Headers(JSON_CT),
      json: async () => ({ error: { code: "INTERNAL_ERROR", message: "out of range" } }),
    } as unknown as Response;
    finalizeQueue.push(fake600);
    const { promise } = start();
    await expect(promise).rejects.toThrow("out of range");
    expect(finalizeCalls).toHaveLength(1);
    expect(uploadFileMock).toHaveBeenCalledTimes(0);
  });

  it("5xx replay中もrequest上限5・delay sequence不変（全attempt 503）", async () => {
    vi.useFakeTimers();
    prepareQueue.push(preparedRes());
    for (let i = 0; i < 5; i++) {
      finalizeQueue.push(new Response("bad gateway", { status: 503, headers: { "content-type": "text/plain" } }));
    }
    const settled = capture(start().promise);
    await vi.advanceTimersByTimeAsync(0);
    expect(finalizeCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(finalizeCalls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(finalizeCalls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(finalizeCalls).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(finalizeCalls).toHaveLength(5);
    expect((await settled).ok).toBe(false);
    expect(prepareCalls).toHaveLength(1);
    expect(uploadToSignedUrlMock).toHaveBeenCalledTimes(1);
  });
});

describe("Fix C: settle直後のtimer / callback残存なし（runAllTimersに頼らない観測）", () => {
  it("成功settle直後: timer 0・以後300秒でrequest/callback増加なし", async () => {
    vi.useFakeTimers();
    prepareQueue.push(preparedRes());
    finalizeQueue.push(finalizeOkRes(201));
    const { stages, promise } = start();
    const settled = capture(promise);
    await vi.advanceTimersByTimeAsync(0); // microtask flushのみ（timer消費なし）
    const result = await settled;
    expect(result.ok).toBe(true);
    expect(vi.getTimerCount()).toBe(0); // settle直後にpending timerが残らない
    const stagesSnap = [...stages];
    const finalizeSnap = finalizeCalls.length;
    const prepareSnap = prepareCalls.length;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(stages).toEqual(stagesSnap);
    expect(finalizeCalls.length).toBe(finalizeSnap);
    expect(prepareCalls.length).toBe(prepareSnap);
    expect(uploadFileMock).toHaveBeenCalledTimes(0);
    expect(uploadToSignedUrlMock).toHaveBeenCalledTimes(1);
  });

  it("exhaustion settle直後: timer 0・以後300秒で6回目なし・legacy 0・callback増加なし", async () => {
    vi.useFakeTimers();
    prepareQueue.push(preparedRes());
    for (let i = 0; i < 5; i++) finalizeQueue.push(new TypeError("Failed to fetch"));
    const { stages, promise } = start();
    const settled = capture(promise);
    // runAllTimersAsyncを使わず、既知のdelay列を刻んでsettleへ到達させる
    for (const step of [0, 5_000, 15_000, 45_000, 90_000]) {
      await vi.advanceTimersByTimeAsync(step);
    }
    const result = await settled;
    expect(result.ok).toBe(false);
    expect(vi.getTimerCount()).toBe(0); // settle直後の観測（残timerの吸収なし）
    const stagesSnap = [...stages];
    await vi.advanceTimersByTimeAsync(300_000);
    expect(finalizeCalls).toHaveLength(5); // 6回目なし
    expect(stages).toEqual(stagesSnap);
    expect(stages).not.toContain("done");
    expect(uploadFileMock).toHaveBeenCalledTimes(0);
    expect(prepareCalls).toHaveLength(1);
    expect(uploadToSignedUrlMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Duplicate prevention
// ---------------------------------------------------------------------------

describe("duplicate prevention", () => {
  it("49) Finalize server成功+response loss→replay 200→client result 1件", async () => {
    vi.useFakeTimers();
    prepareQueue.push(preparedRes());
    finalizeQueue.push(new TypeError("Failed to fetch")); // server側はFINALIZED済みの想定
    finalizeQueue.push(finalizeOkRes(200)); // 冪等replay
    const settled = capture(start().promise);
    await vi.runAllTimersAsync();
    const result = await settled;
    expect(result.ok).toBe(true);
    const value = (result as { value: { item: unknown } }).value;
    expect(value.item).toEqual(ITEM); // item 1件相当（同一intentの200 replay）
    expect(finalizeCalls).toEqual([{ intentId: INTENT_ID }, { intentId: INTENT_ID }]);
    expect(prepareCalls).toHaveLength(1); // new intentを自動生成しない
  });

  it("成功statusでbody欠損（response loss変種）もsame-intent replayで収束", async () => {
    vi.useFakeTimers();
    prepareQueue.push(preparedRes());
    finalizeQueue.push(new Response("{truncated", { status: 201, headers: JSON_CT }));
    finalizeQueue.push(finalizeOkRes(200));
    const settled = capture(start().promise);
    await vi.runAllTimersAsync();
    expect((await settled).ok).toBe(true);
    expect(finalizeCalls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

describe("privacy", () => {
  it("61-63) serialized errorにtoken/path/provider raw messageを含めない", async () => {
    uploadToSignedUrlMock.mockResolvedValue({ data: null, error: { name: "StorageApiError", status: 403, statusCode: "403", message: `provider detail leaking ${SECRET_TOKEN}` } });
    prepareQueue.push(preparedRes());
    finalizeQueue.push(errRes(409, "OBJECT_MISSING", "Upload the file to storage before finalizing."));
    const settled = await capture(start().promise);
    expect(settled.ok).toBe(false);
    const err = (settled as { error: unknown }).error as Error;
    const text = String(err) + JSON.stringify({ message: err.message, name: err.name });
    expect(text).not.toContain(SECRET_TOKEN);
    expect(text).not.toContain(SECRET_PATH);
    expect(text).not.toContain("provider detail");
  });
});

// ---------------------------------------------------------------------------
// Wiring / build source contract（static assertions — finalize test 6 と同型）
// ---------------------------------------------------------------------------

describe("wiring / build source contract（static）", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  const orchestratorSrc = read("./directUploadClient.ts");
  const pageSrc = read("../../app/quick-add/page.tsx");
  const clientSrc = read("../../app/quick-add/QuickAddClient.tsx");

  it("64-67) production moduleにprocess.env / server専用stub / lease定数import / NEXT_PUBLICなし", () => {
    expect(orchestratorSrc).not.toContain("process.env");
    expect(orchestratorSrc).not.toContain("server-only");
    expect(orchestratorSrc).not.toContain("FINALIZE_LEASE" + "_MS");
    expect(orchestratorSrc).not.toContain("NEXT_PUBLIC");
    expect(orchestratorSrc).not.toContain("UPLOAD_DIRECT" + "_ENABLED");
  });

  it("68-70) flag readerはpage.tsxのみ・QuickAddClientはboolean propのみ受領", () => {
    expect(pageSrc).toContain('from "@/lib/upload/directUploadFeature"');
    expect(pageSrc).toContain("directUploadEnabled={readDirectUploadEnabledFlag()}");
    expect(clientSrc).not.toContain("readDirectUploadEnabledFlag");
    expect(clientSrc).not.toContain("directUploadFeature");
    expect(clientSrc).not.toContain("process.env");
    expect(clientSrc).toContain("directUploadEnabled: boolean");
  });

  it("54,56-58) QuickAdd wiring非回帰: uploadFnはref固定・MAX_CONCURRENT=2・selection順append・新UI文言なし", () => {
    expect(clientSrc).toContain("const uploadFnRef = useRef(selectUploadFileFn(directUploadEnabled));");
    expect(clientSrc).toContain("await uploadFnRef.current(file, sid,");
    expect(clientSrc).toContain("const MAX_CONCURRENT = 2;");
    expect(clientSrc).toContain("setItems((prev) => [...prev, newItem]);");
    // stage写像は既存のまま（progress.stageをそのままstatusへ）
    expect(clientSrc).toContain("updateItem(clientId, { status: stage });");
    // legacy直呼びは残らない（選択はselectUploadFileFn経由のみ）— 型importは許可
    expect(clientSrc).not.toContain("uploadFile(file");
    expect(clientSrc).toContain('import { selectUploadFileFn } from "@/lib/upload/directUploadClient";');
  });

  it("60) restore / preview / commit契約への影響なし（既存導線がsourceに不変で存在）", () => {
    expect(clientSrc).toContain('fetch(`/api/uploads/session/${stored.sessionId}`)');
    expect(clientSrc).toContain('"/api/storage/signed-url"');
    expect(clientSrc).toContain("/quick-add/commit?sessionId=");
    expect(clientSrc).toContain("RestoreSessionBanner");
  });
});
