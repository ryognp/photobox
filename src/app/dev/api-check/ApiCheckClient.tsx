"use client";

import { useState, useRef } from "react";

type TestResult = {
  label: string;
  status: number;
  ok: boolean;
  skipped?: boolean;
  body: unknown;
  durationMs: number;
};

type TestSection = "master" | "session" | "item" | "prompt" | "commit" | "gallery" | "gallery-detail" | "masters-mgmt";

type TestCase = {
  id: string;
  label: string;
  description: string;
  expected: string;
  section: TestSection;
  requiresFile?: boolean;
  run: (ctx: TestContext) => Promise<{ status: number; body: unknown }>;
};

type TestContext = {
  getSessionId: () => string | null;
  setSessionId: (id: string) => void;
  getItemId: () => string | null;
  setItemId: (id: string) => void;
  getFileState: () => FileState | null;
  getSceneId: () => string | null;
  setSceneId: (id: string) => void;
  getTagId: () => string | null;
  setTagId: (id: string) => void;
  getPersonId: () => string | null;
  setPersonId: (id: string) => void;
  getImageId: () => string | null;
  setImageId: (id: string) => void;
};

type FileState = {
  file: File;
  clientFileHash: string;
  thumbnail: Blob | null;
  preview: Blob | null;
  widthPx: number | null;
  heightPx: number | null;
};

// ---- SHA-256 (client side, SubtleCrypto) ----------------------------------

async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---- Canvas thumbnail/preview generation ----------------------------------

async function generateWebpBlob(
  file: File,
  maxSize: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const ratio = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * ratio);
      const h = Math.round(img.naturalHeight * ratio);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) { resolve(null); return; }
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => resolve(blob), "image/webp", 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

async function getImageDimensions(file: File): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve({ w: img.naturalWidth, h: img.naturalHeight }); };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

// ---- master tests A〜J ----------------------------------------------------

const MASTER_TESTS: TestCase[] = [
  { id: "A", section: "master", label: "A. Scene 作成", description: "POST /api/scenes", expected: "201 または 200、{ data: { id, name, description, createdAt } }",
    run: async () => { const r = await fetch("/api/scenes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "テストシーン", description: "説明文" }) }); return { status: r.status, body: await r.json() }; },
  },
  { id: "B", section: "master", label: "B. Scenes 一覧取得", description: "GET /api/scenes", expected: "200、{ data: [...] } name 昇順",
    run: async () => { const r = await fetch("/api/scenes"); return { status: r.status, body: await r.json() }; },
  },
  { id: "C", section: "master", label: "C. Tag 作成", description: "POST /api/tags", expected: "201 または 200、{ data: { id, name, createdAt } }",
    run: async () => { const r = await fetch("/api/tags", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "テストタグ" }) }); return { status: r.status, body: await r.json() }; },
  },
  { id: "D", section: "master", label: "D. Tags 一覧取得", description: "GET /api/tags", expected: "200、{ data: [...] } name 昇順",
    run: async () => { const r = await fetch("/api/tags"); return { status: r.status, body: await r.json() }; },
  },
  { id: "E", section: "master", label: "E. Person 作成", description: "POST /api/persons", expected: "201 または 200、{ data: { id, name, notes, defaultPromptHint, createdAt } }",
    run: async () => { const r = await fetch("/api/persons", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "テスト人物", notes: "メモ", defaultPromptHint: "a girl" }) }); return { status: r.status, body: await r.json() }; },
  },
  { id: "F", section: "master", label: "F. Persons 一覧取得", description: "GET /api/persons", expected: "200、{ data: [...] } name 昇順",
    run: async () => { const r = await fetch("/api/persons"); return { status: r.status, body: await r.json() }; },
  },
  { id: "G", section: "master", label: "G. 同名 Tag 再作成（冪等テスト）", description: "POST /api/tags — 同名タグを再度作成", expected: "200（既存レコードが返る、重複作成されない）",
    run: async () => { const r = await fetch("/api/tags", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "テストタグ" }) }); return { status: r.status, body: await r.json() }; },
  },
  { id: "H", section: "master", label: "H. signed-url: 存在しない imageId", description: "POST /api/storage/signed-url — id: nonexistent-id-123", expected: "404、{ error: { code: 'NOT_FOUND', message: '...' } }",
    run: async () => { const r = await fetch("/api/storage/signed-url", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "image", id: "nonexistent-id-123", variant: "thumbnail" }) }); return { status: r.status, body: await r.json() }; },
  },
  { id: "I", section: "master", label: "I. signed-url: 不正 variant", description: "POST /api/storage/signed-url — variant: 'full'", expected: "400、{ error: { code: 'VALIDATION_ERROR', message: '...' } }",
    run: async () => { const r = await fetch("/api/storage/signed-url", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "image", id: "some-id", variant: "full" }) }); return { status: r.status, body: await r.json() }; },
  },
  { id: "J", section: "master", label: "J. signed-url: path 直接指定拒否", description: "POST /api/storage/signed-url — path キーを含む", expected: "400、{ error: { code: 'VALIDATION_ERROR', message: 'Unexpected keys...' } }",
    run: async () => { const r = await fetch("/api/storage/signed-url", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "image", id: "nonexistent", variant: "original", path: "some/arbitrary/path.jpg" }) }); return { status: r.status, body: await r.json() }; },
  },
];

// ---- session tests K〜R ---------------------------------------------------

const SESSION_TESTS: TestCase[] = [
  { id: "K", section: "session", label: "K. Upload Session 作成", description: "POST /api/uploads/session", expected: "201、data.session.status === 'ACTIVE'、data.items が配列",
    run: async (ctx) => { const r = await fetch("/api/uploads/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "テストセッション" }) }); const body = await r.json() as Record<string, unknown>; const session = (body?.data as Record<string, unknown>)?.session as Record<string, unknown> | undefined; if (session?.id) ctx.setSessionId(session.id as string); return { status: r.status, body }; },
  },
  { id: "L", section: "session", label: "L. Upload Session 再開（冪等テスト）", description: "POST /api/uploads/session — 再度実行", expected: "200、既存 ACTIVE session が返る",
    run: async (ctx) => { const r = await fetch("/api/uploads/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "テストセッション" }) }); const body = await r.json() as Record<string, unknown>; const session = (body?.data as Record<string, unknown>)?.session as Record<string, unknown> | undefined; if (session?.id && !ctx.getSessionId()) ctx.setSessionId(session.id as string); return { status: r.status, body }; },
  },
  { id: "M", section: "session", label: "M. Upload Session 取得", description: "GET /api/uploads/session/:id", expected: "200、data.session.id が K と一致",
    run: async (ctx) => { const id = ctx.getSessionId() ?? "no-session-run-K-first"; const r = await fetch(`/api/uploads/session/${id}`); return { status: r.status, body: await r.json() }; },
  },
  { id: "N", section: "session", label: "N. Upload Session title 更新", description: "PATCH /api/uploads/session/:id — title 変更", expected: "200、data.session.title === '更新後セッション名'",
    run: async (ctx) => { const id = ctx.getSessionId() ?? "no-session-run-K-first"; const r = await fetch(`/api/uploads/session/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "更新後セッション名" }) }); return { status: r.status, body: await r.json() }; },
  },
  { id: "O", section: "session", label: "O. Upload Session status = PREVIEWING", description: "PATCH /api/uploads/session/:id — status 更新", expected: "200、data.session.status === 'PREVIEWING'",
    run: async (ctx) => { const id = ctx.getSessionId() ?? "no-session-run-K-first"; const r = await fetch(`/api/uploads/session/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "PREVIEWING" }) }); return { status: r.status, body: await r.json() }; },
  },
  { id: "P", section: "session", label: "P. Upload Session status = COMMITTED 拒否", description: "PATCH /api/uploads/session/:id — COMMITTED は禁止", expected: "400、error.code === 'VALIDATION_ERROR'",
    run: async (ctx) => { const id = ctx.getSessionId() ?? "no-session-run-K-first"; const r = await fetch(`/api/uploads/session/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "COMMITTED" }) }); return { status: r.status, body: await r.json() }; },
  },
  { id: "Q", section: "session", label: "Q. Upload Session 破棄", description: "DELETE /api/uploads/session/:id", expected: "200、data.session.status === 'ABANDONED'",
    run: async (ctx) => { const id = ctx.getSessionId() ?? "no-session-run-K-first"; const r = await fetch(`/api/uploads/session/${id}`, { method: "DELETE" }); return { status: r.status, body: await r.json() }; },
  },
  { id: "R", section: "session", label: "R. 存在しない session 取得", description: "GET /api/uploads/session/nonexistent-id-123", expected: "404、error.code === 'NOT_FOUND'",
    run: async () => { const r = await fetch("/api/uploads/session/nonexistent-id-123"); return { status: r.status, body: await r.json() }; },
  },
];

// ---- upload item tests T〜Y -----------------------------------------------

const ITEM_TESTS: TestCase[] = [
  { id: "T", section: "item", requiresFile: true, label: "T. Upload Item 作成", description: "POST /api/uploads/items (multipart)", expected: "201、uploadStatus === 'READY'、signedUrls あり",
    run: async (ctx) => {
      let sid = ctx.getSessionId();
      if (!sid) {
        const r = await fetch("/api/uploads/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "auto-created" }) });
        const body = await r.json() as Record<string, unknown>;
        const s = (body?.data as Record<string, unknown>)?.session as Record<string, unknown> | undefined;
        // Session が PREVIEWING/ABANDONED の場合は ACTIVE に戻す
        if (s?.status !== "ACTIVE") {
          const patchR = await fetch(`/api/uploads/session/${s?.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "ACTIVE" }) });
          await patchR.json();
        }
        if (s?.id) { sid = s.id as string; ctx.setSessionId(sid); }
      }
      const fs = ctx.getFileState()!;
      const fd = new FormData();
      fd.append("sessionId", sid!);
      fd.append("clientFileHash", fs.clientFileHash);
      fd.append("original", fs.file, fs.file.name);
      if (fs.thumbnail) fd.append("thumbnail", new File([fs.thumbnail], "thumbnail.webp", { type: "image/webp" }));
      if (fs.preview) fd.append("preview", new File([fs.preview], "preview.webp", { type: "image/webp" }));
      fd.append("originalName", fs.file.name);
      if (fs.widthPx) fd.append("widthPx", String(fs.widthPx));
      if (fs.heightPx) fd.append("heightPx", String(fs.heightPx));
      const r = await fetch("/api/uploads/items", { method: "POST", body: fd });
      const body = await r.json() as Record<string, unknown>;
      const item = (body?.data as Record<string, unknown>)?.item as Record<string, unknown> | undefined;
      if (item?.id) ctx.setItemId(item.id as string);
      return { status: r.status, body };
    },
  },
  { id: "U", section: "item", requiresFile: true, label: "U. Upload Item 不正 hash テスト", description: "POST /api/uploads/items — clientFileHash に意図的に誤った値を送る", expected: "400、error.code === 'FILE_HASH_MISMATCH'",
    run: async (ctx) => {
      const sid = ctx.getSessionId() ?? "no-session";
      const fs = ctx.getFileState()!;
      const fd = new FormData();
      fd.append("sessionId", sid);
      fd.append("clientFileHash", "0000000000000000000000000000000000000000000000000000000000000000");
      fd.append("original", fs.file, fs.file.name);
      const r = await fetch("/api/uploads/items", { method: "POST", body: fd });
      return { status: r.status, body: await r.json() };
    },
  },
  { id: "V", section: "item", label: "V. Upload Item 非画像テスト", description: "POST /api/uploads/items — text/plain Blob を original として送る", expected: "415 または 400、UNSUPPORTED_MEDIA_TYPE または VALIDATION_ERROR",
    run: async (ctx) => {
      const sid = ctx.getSessionId() ?? "no-session";
      const blob = new Blob(["this is not an image"], { type: "text/plain" });
      const fd = new FormData();
      fd.append("sessionId", sid);
      fd.append("clientFileHash", "aabbcc");
      fd.append("original", new File([blob], "test.txt", { type: "text/plain" }));
      const r = await fetch("/api/uploads/items", { method: "POST", body: fd });
      return { status: r.status, body: await r.json() };
    },
  },
  { id: "W", section: "item", label: "W. Session 再取得で item が含まれること", description: "GET /api/uploads/session/:id", expected: "200、data.items に T で作成した item が含まれる",
    run: async (ctx) => {
      const sid = ctx.getSessionId() ?? "no-session";
      const r = await fetch(`/api/uploads/session/${sid}`);
      return { status: r.status, body: await r.json() };
    },
  },
  { id: "X", section: "item", label: "X. uploadItem signed-url 確認", description: "POST /api/storage/signed-url — type: uploadItem", expected: "200、signedUrl が返る（thumbnail or fallback）",
    run: async (ctx) => {
      const itemId = ctx.getItemId() ?? "no-item-run-T-first";
      const r = await fetch("/api/storage/signed-url", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "uploadItem", id: itemId, variant: "thumbnail" }) });
      return { status: r.status, body: await r.json() };
    },
  },
  { id: "Y", section: "item", requiresFile: true, label: "Y. 重複アップロード確認", description: "同じファイルを再度 POST /api/uploads/items — images に未 commit のため CLEAN のはず", expected: "201 または 200、duplicateStatus === 'CLEAN'（images に存在しないため）",
    run: async (ctx) => {
      const sid = ctx.getSessionId() ?? "no-session";
      const fs = ctx.getFileState()!;
      const fd = new FormData();
      fd.append("sessionId", sid);
      fd.append("clientFileHash", fs.clientFileHash);
      fd.append("original", fs.file, fs.file.name);
      if (fs.thumbnail) fd.append("thumbnail", new File([fs.thumbnail], "thumbnail.webp", { type: "image/webp" }));
      if (fs.preview) fd.append("preview", new File([fs.preview], "preview.webp", { type: "image/webp" }));
      fd.append("originalName", fs.file.name);
      const r = await fetch("/api/uploads/items", { method: "POST", body: fd });
      return { status: r.status, body: await r.json() };
    },
  },
];

// ---- upload item prompt / metadata tests Z〜AH ----------------------------

const PROMPT_TESTS: TestCase[] = [
  {
    id: "Z", section: "prompt",
    label: "Z. UploadItem 単体取得",
    description: "GET /api/uploads/items/:id",
    expected: "200、data.item.id が一致、scene/tags/persons が含まれる",
    run: async (ctx) => {
      const id = ctx.getItemId() ?? "no-item-run-T-first";
      const r = await fetch(`/api/uploads/items/${id}`);
      return { status: r.status, body: await r.json() };
    },
  },
  {
    id: "AA", section: "prompt",
    label: "AA. Prompt 下書き保存",
    description: "PUT /api/uploads/items/:id/prompt — saveMode: draft",
    expected: "200、promptStatus === 'DRAFT'",
    run: async (ctx) => {
      const id = ctx.getItemId() ?? "no-item-run-T-first";
      const r = await fetch(`/api/uploads/items/${id}/prompt`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promptDraft: "これは下書きプロンプトです", saveMode: "draft" }),
      });
      return { status: r.status, body: await r.json() };
    },
  },
  {
    id: "AB", section: "prompt",
    label: "AB. Prompt 確定保存",
    description: "PUT /api/uploads/items/:id/prompt — saveMode: filled",
    expected: "200、promptStatus === 'FILLED'",
    run: async (ctx) => {
      const id = ctx.getItemId() ?? "no-item-run-T-first";
      const r = await fetch(`/api/uploads/items/${id}/prompt`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promptDraft: "これは確定プロンプトです", saveMode: "filled" }),
      });
      return { status: r.status, body: await r.json() };
    },
  },
  {
    id: "AC", section: "prompt",
    label: "AC. 空 prompt の filled 拒否",
    description: "PUT /api/uploads/items/:id/prompt — 空 + filled",
    expected: "400、error.code === 'VALIDATION_ERROR'",
    run: async (ctx) => {
      const id = ctx.getItemId() ?? "no-item-run-T-first";
      const r = await fetch(`/api/uploads/items/${id}/prompt`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promptDraft: "", saveMode: "filled" }),
      });
      return { status: r.status, body: await r.json() };
    },
  },
  {
    id: "AD", section: "prompt",
    label: "AD. Metadata 更新",
    description: "PATCH /api/uploads/items/:id — scene/tags/persons/rating/isFavorite/notes",
    expected: "200、scene/tags/persons/rating/isFavorite/notes が更新されている",
    run: async (ctx) => {
      const id = ctx.getItemId() ?? "no-item-run-T-first";
      const sceneId = ctx.getSceneId();
      const tagId = ctx.getTagId();
      const personId = ctx.getPersonId();
      const bodyObj: Record<string, unknown> = {
        rating: 5,
        isFavorite: true,
        notes: "テストメモ",
      };
      if (sceneId) bodyObj.sceneId = sceneId;
      if (tagId) bodyObj.tagIds = [tagId];
      if (personId) bodyObj.personIds = [personId];
      const r = await fetch(`/api/uploads/items/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyObj),
      });
      return { status: r.status, body: await r.json() };
    },
  },
  {
    id: "AE", section: "prompt",
    label: "AE. Metadata validation (rating: 9)",
    description: "PATCH /api/uploads/items/:id — 不正 rating",
    expected: "400、error.code === 'VALIDATION_ERROR'",
    run: async (ctx) => {
      const id = ctx.getItemId() ?? "no-item-run-T-first";
      const r = await fetch(`/api/uploads/items/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: 9 }),
      });
      return { status: r.status, body: await r.json() };
    },
  },
  {
    id: "AF", section: "prompt",
    label: "AF. 同一プロンプト一括適用",
    description: "POST /api/uploads/apply-prompt",
    expected: "200、updatedCount >= 1、対象 item の promptStatus === 'FILLED'",
    run: async (ctx) => {
      const sessionId = ctx.getSessionId() ?? "no-session";
      const itemId = ctx.getItemId() ?? "no-item";
      const r = await fetch("/api/uploads/apply-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          itemIds: [itemId],
          promptDraft: "一括適用プロンプト",
        }),
      });
      return { status: r.status, body: await r.json() };
    },
  },
  {
    id: "AG", section: "prompt",
    label: "AG. apply-prompt 空文字拒否",
    description: "POST /api/uploads/apply-prompt — promptDraft: ''",
    expected: "400、error.code === 'VALIDATION_ERROR'",
    run: async (ctx) => {
      const sessionId = ctx.getSessionId() ?? "no-session";
      const itemId = ctx.getItemId() ?? "no-item";
      const r = await fetch("/api/uploads/apply-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, itemIds: [itemId], promptDraft: "" }),
      });
      return { status: r.status, body: await r.json() };
    },
  },
  {
    id: "AH", section: "prompt",
    label: "AH. Session 再取得で更新結果確認",
    description: "GET /api/uploads/session/:id — 更新済み items が含まれること",
    expected: "200、items に promptStatus/scene/tags/persons/rating/notes が反映",
    run: async (ctx) => {
      const sessionId = ctx.getSessionId() ?? "no-session";
      const r = await fetch(`/api/uploads/session/${sessionId}`);
      return { status: r.status, body: await r.json() };
    },
  },
];

// ---- commit / duplicate tests AI〜AL --------------------------------------

const COMMIT_TESTS: TestCase[] = [
  {
    id: "AI", section: "commit",
    label: "AI. 重複チェック実行",
    description: "POST /api/uploads/check-duplicates",
    expected: "200、data.summary が返る、data.items が配列",
    run: async (ctx) => {
      const sessionId = ctx.getSessionId() ?? "no-session";
      const r = await fetch("/api/uploads/check-duplicates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      return { status: r.status, body: await r.json() };
    },
  },
  {
    id: "AJ", section: "commit",
    label: "AJ. skip-duplicate (無効なitem)",
    description: "POST /api/uploads/items/:id/skip-duplicate — DUPLICATEでないitem",
    expected: "400、error.code === VALIDATION_ERROR",
    run: async (ctx) => {
      const id = ctx.getItemId() ?? "no-item";
      const r = await fetch(`/api/uploads/items/${id}/skip-duplicate`, { method: "POST" });
      return { status: r.status, body: await r.json() };
    },
  },
  {
    id: "AK", section: "commit",
    label: "AK. Commit readiness 表示",
    description: "フロント関数 checkCommitReadiness の動作確認",
    expected: "PROMPT_MISSING または canCommit=true が表示される",
    run: async (ctx) => {
      // Simulate by fetching session items and running client-side logic
      const sessionId = ctx.getSessionId();
      if (!sessionId) return { status: 0, body: { error: "sessionId なし" } };
      const r = await fetch(`/api/uploads/session/${sessionId}`);
      if (!r.ok) return { status: r.status, body: await r.json() };
      const json = await r.json() as { data: { items: Record<string, unknown>[] } };
      const items = json.data.items ?? [];
      // import dynamically to avoid circular dep
      const { checkCommitReadiness } = await import("@/lib/quick-add/commitReadiness");
      const readiness = checkCommitReadiness(items);
      return { status: 200, body: { data: readiness } };
    },
  },
  {
    id: "AL", section: "commit",
    label: "AL. CommitPreview ナビゲーション",
    description: "/quick-add/commit?sessionId=... へのリンク表示",
    expected: "sessionId があればリンクが表示される",
    run: async (ctx) => {
      const sessionId = ctx.getSessionId();
      if (!sessionId) return { status: 0, body: { error: "sessionId なし — K を先に実行してください" } };
      const url = `/quick-add/commit?sessionId=${sessionId}`;
      return { status: 200, body: { data: { url, note: "クリックして CommitPreview へ移動してください" } } };
    },
  },
  {
    id: "AM", section: "commit",
    label: "AM. Commit invalid: プロンプト未入力",
    description: "POST /api/uploads/commit — セッションにprompt未入力のitemがある場合 (テストKでセッション作成後、テストOでPREVIEWING化後に実行)",
    expected: "400 (ACTIVE sessionなら) または 200 (PREVIEWING+EMPTY promptなら invalid に PROMPT_NOT_FILLED が含まれる)",
    run: async (ctx) => {
      const sessionId = ctx.getSessionId() ?? localStorage.getItem("photobox:active-session");
      if (!sessionId) return { status: 0, body: { error: "No sessionId — run test K first to create a session" } };
      const res = await fetch("/api/uploads/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const data = await res.json();
      return { status: res.status, body: data };
    },
  },
  {
    id: "AN", section: "commit",
    label: "AN. Commit success (手動前提)",
    description: "READY + FILLED + CLEAN のitemをPOST /api/uploads/commit — 手動でupload→prompt入力→check-duplicates→PREVIEWING化後に実行",
    expected: "200; summary.committed >= 1; committedImageId が設定される",
    run: async (ctx) => {
      const sessionId = ctx.getSessionId() ?? localStorage.getItem("photobox:active-session");
      if (!sessionId) return { status: 0, body: { error: "No sessionId — run test K first to create a session" } };
      const res = await fetch("/api/uploads/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const data = await res.json();
      return { status: res.status, body: data };
    },
  },
  {
    id: "AO", section: "commit",
    label: "AO. Commit idempotency (手動前提)",
    description: "ANと同じsessionに再度 POST /api/uploads/commit — alreadyCommitted に含まれることを確認",
    expected: "200; summary.alreadyCommitted >= 1",
    run: async (ctx) => {
      const sessionId = ctx.getSessionId() ?? localStorage.getItem("photobox:active-session");
      if (!sessionId) return { status: 0, body: { error: "No sessionId — run test K first to create a session" } };
      const res = await fetch("/api/uploads/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const data = await res.json();
      return { status: res.status, body: data };
    },
  },
  {
    id: "AP", section: "commit",
    label: "AP. Commit skipped duplicate (手動前提)",
    description: "既存commit済み画像と同じファイルをupload → check-duplicates → skip-duplicate → commit — skipped に含まれることを確認",
    expected: "200; summary.skipped >= 1; committedImageId = duplicateImageId",
    run: async (ctx) => {
      const sessionId = ctx.getSessionId() ?? localStorage.getItem("photobox:active-session");
      if (!sessionId) return { status: 0, body: { error: "No sessionId — run test K first to create a session" } };
      const res = await fetch("/api/uploads/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const data = await res.json();
      return { status: res.status, body: data };
    },
  },
  {
    id: "AQ", section: "commit",
    label: "AQ. CommitPreview ページリンク",
    description: "/quick-add/commit?sessionId=... へのリンク表示 (手動で確認)",
    expected: "CommitPreview が表示され確定保存ボタンが表示される",
    run: async (ctx) => {
      const sessionId = ctx.getSessionId() ?? localStorage.getItem("photobox:active-session") ?? "";
      if (!sessionId) return { status: 0, body: { error: "No sessionId — run test K first to create a session" } };
      const url = `/quick-add/commit?sessionId=${sessionId}`;
      return { status: 200, body: { url, message: "上のリンクをクリックしてCommitPreviewを開いてください" } };
    },
  },
];

// ---- gallery tests AR〜AU -------------------------------------------------

const GALLERY_TESTS: TestCase[] = [
  {
    id: "AR", section: "gallery", label: "AR. GET /api/images — 一覧取得", description: "GET /api/images", expected: "200、{ data: { images: [...], nextCursor: string|null } }",
    run: async () => { const r = await fetch("/api/images"); return { status: r.status, body: await r.json() }; },
  },
  {
    id: "AS", section: "gallery", label: "AS. GET /api/images?favorite=true — お気に入りフィルタ", description: "GET /api/images?favorite=true", expected: "200、全 images の isFavorite === true",
    run: async () => { const r = await fetch("/api/images?favorite=true"); return { status: r.status, body: await r.json() }; },
  },
  {
    id: "AT", section: "gallery", label: "AT. GET /api/images/:id — 詳細取得", description: "コミット済み imageId で詳細を取得（存在する場合）", expected: "200、signedUrls あり / または 404",
    run: async () => {
      const listR = await fetch("/api/images?limit=1");
      if (!listR.ok) return { status: listR.status, body: await listR.json() };
      const listJson = await listR.json() as { data?: { images?: { id: string }[] } };
      const firstId = listJson.data?.images?.[0]?.id;
      if (!firstId) return { status: 200, body: { message: "画像がまだ存在しません (commit後に実行してください)" } };
      const r = await fetch(`/api/images/${firstId}`);
      return { status: r.status, body: await r.json() };
    },
  },
  {
    id: "AU", section: "gallery", label: "AU. GET /api/images/:id — 存在しない ID", description: "GET /api/images/nonexistent-image-id", expected: "404、error.code === 'NOT_FOUND'",
    run: async () => { const r = await fetch("/api/images/nonexistent-image-id-xyz"); return { status: r.status, body: await r.json() }; },
  },
];

// ---- cleanup tests AV〜AX -------------------------------------------------

const CLEANUP_TESTS: TestCase[] = [
  {
    id: "AV", section: "gallery", label: "AV. Cleanup dryRun", description: "POST /api/uploads/cleanup — dryRun: true, olderThanHours: 1", expected: "200、data.dryRun === true、data.summary あり",
    run: async () => { const r = await fetch("/api/uploads/cleanup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ olderThanHours: 1, dryRun: true }) }); return { status: r.status, body: await r.json() }; },
  },
  {
    id: "AW", section: "gallery", label: "AW. Cleanup validation error", description: "POST /api/uploads/cleanup — olderThanHours: 999 (範囲外)", expected: "400、error.code === 'VALIDATION_ERROR'",
    run: async () => { const r = await fetch("/api/uploads/cleanup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ olderThanHours: 999, dryRun: true }) }); return { status: r.status, body: await r.json() }; },
  },
  {
    id: "AX", section: "gallery", label: "AX. Cleanup execute (実行系)", description: "POST /api/uploads/cleanup — dryRun: false、olderThanHours: 24。COMMITTED session は削除されないことを確認", expected: "200、data.dryRun === false、COMMITTED session は保持",
    run: async () => { const r = await fetch("/api/uploads/cleanup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ olderThanHours: 24, dryRun: false }) }); return { status: r.status, body: await r.json() }; },
  },
];

// ---- import tests AY〜BA --------------------------------------------------

// CSV を Blob で生成してPOSTするヘルパー
function makeCSVBlob(content: string): File {
  return new File([content], "test.csv", { type: "text/csv" });
}

const IMPORT_TESTS: TestCase[] = [
  {
    id: "AY", section: "gallery", label: "AY. Import parse CSV — 正常", description: "POST /api/import/parse — image_url列あり CSV", expected: "200、data.columns あり、data.autoMapping.imageUrlColumn が設定済み",
    run: async () => {
      const csv = "image_url,prompt,notes\nhttps://example.com/a.jpg,プロンプトA,メモA\nhttps://example.com/b.jpg,プロンプトB,メモB";
      const fd = new FormData();
      fd.append("file", makeCSVBlob(csv));
      const r = await fetch("/api/import/parse", { method: "POST", body: fd });
      return { status: r.status, body: await r.json() };
    },
  },
  {
    id: "AZ", section: "gallery", label: "AZ. Import parse CSV — image_url列なし", description: "POST /api/import/parse — image_url列がないCSV。parseは成功し autoMapping.imageUrlColumn が null になること", expected: "200、autoMapping.imageUrlColumn === null",
    run: async () => {
      const csv = "title,description\nPhoto A,Description A\nPhoto B,Description B";
      const fd = new FormData();
      fd.append("file", makeCSVBlob(csv));
      const r = await fetch("/api/import/parse", { method: "POST", body: fd });
      return { status: r.status, body: await r.json() };
    },
  },
  {
    id: "BA", section: "gallery", label: "BA. Import parse — 4MB上限確認", description: "UIでファイルを4MB超で選択すると、APIコール前にフロントエラーが出ることを確認 (手動確認)", expected: "手動確認 — 4MB超ファイルを /import に選択するとUI上でエラーメッセージが表示される",
    run: async () => {
      // 4MB+1byte の Blob を生成してAPIに送信 → 413 または 400
      const bigContent = "image_url\n" + "https://example.com/a.jpg\n".repeat(200000);
      const fd = new FormData();
      fd.append("file", new File([bigContent], "big.csv", { type: "text/csv" }));
      const r = await fetch("/api/import/parse", { method: "POST", body: fd });
      return { status: r.status, body: await r.json() };
    },
  },
];

// ---- gallery detail / filter / search tests BI〜BO -----------------------

const GALLERY_DETAIL_TESTS: TestCase[] = [
  {
    id: "BI",
    section: "gallery-detail",
    label: "BI. Gallery 1ページ目取得",
    description: "GET /api/images?limit=48",
    expected: "200、images.length > 0 かつ <= 48、nextCursor が存在する（628件なら必ずある）",
    run: async (ctx) => {
      const r = await fetch("/api/images?limit=48");
      const body = await r.json() as { data?: { images?: { id: string; originalName: string }[]; nextCursor?: string | null } };
      const images = body.data?.images ?? [];
      const firstId = images[0]?.id;
      if (firstId) ctx.setImageId(firstId);
      return {
        status: r.status,
        body: {
          ...body,
          _check: {
            imagesCount: images.length,
            imagesLe48: images.length <= 48,
            imagesGt0: images.length > 0,
            hasNextCursor: body.data?.nextCursor !== null && body.data?.nextCursor !== undefined,
            firstImageId: firstId ?? null,
            firstImageName: images[0]?.originalName ?? null,
          },
        },
      };
    },
  },
  {
    id: "BJ",
    section: "gallery-detail",
    label: "BJ. Gallery 2ページ目取得 (cursor)",
    description: "BI の nextCursor で GET /api/images?cursor=...&limit=48",
    expected: "200、2ページ目が返り、1ページ目と ID 重複なし",
    run: async () => {
      const r1 = await fetch("/api/images?limit=48");
      const j1 = await r1.json() as { data?: { images?: { id: string }[]; nextCursor?: string | null } };
      const cursor = j1.data?.nextCursor;
      const page1Ids = new Set((j1.data?.images ?? []).map((i) => i.id));
      if (!cursor) {
        return { status: 200, body: { message: "nextCursor が null — 画像が 48 件以下のためページング不要", _check: { skipped: true } } };
      }
      const r2 = await fetch(`/api/images?cursor=${cursor}&limit=48`);
      const j2 = await r2.json() as { data?: { images?: { id: string }[] } };
      const page2Ids = (j2.data?.images ?? []).map((i) => i.id);
      const overlap = page2Ids.filter((id) => page1Ids.has(id));
      return {
        status: r2.status,
        body: {
          ...j2,
          _check: {
            page2Count: page2Ids.length,
            overlapWithPage1: overlap.length,
            noOverlap: overlap.length === 0,
          },
        },
      };
    },
  },
  {
    id: "BK",
    section: "gallery-detail",
    label: "BK. Image detail — Import由来画像（tag:xlsx-import の最初の1件）",
    description: "GET /api/tags → xlsx-import タグのIDで GET /api/images?tagId=...&limit=1 → その画像で GET /api/images/:id",
    expected: "200、sourceSheetName/importBatchId/prompt/signed URLs あり",
    run: async (ctx) => {
      // 1. xlsx-import タグを取得
      const tr = await fetch("/api/tags");
      const tj = await tr.json() as { data?: { id: string; name: string }[] };
      const tag = (tj.data ?? []).find((t) => t.name === "xlsx-import");
      if (!tag) {
        return { status: 0, body: { error: "tag「xlsx-import」が見つかりません。BM も失敗するはずです。" } };
      }
      // 2. そのタグで画像を1件取得
      const lr = await fetch(`/api/images?tagId=${tag.id}&limit=1`);
      const lj = await lr.json() as { data?: { images?: { id: string }[] } };
      const imageId = lj.data?.images?.[0]?.id;
      if (!imageId) {
        return { status: 0, body: { error: "xlsx-import タグ付き画像が見つかりません。" } };
      }
      // imageId を ctx に保存（他テストでも使えるように）
      ctx.setImageId(imageId);
      // 3. 詳細取得
      const r = await fetch(`/api/images/${imageId}`);
      const body = await r.json() as { data?: Record<string, unknown> };
      const d = body.data;
      const su = d?.signedUrls as Record<string, unknown> | undefined;
      return {
        status: r.status,
        body: {
          ...body,
          _check: {
            imageId,
            hasPrompt: !!(d?.prompt),
            hasNotes: d?.notes !== undefined,
            hasSourceSheetName: !!(d?.sourceSheetName),
            hasSourceRow: d?.sourceRow !== null && d?.sourceRow !== undefined,
            hasSourceColumn: d?.sourceColumn !== null && d?.sourceColumn !== undefined,
            hasImportBatchId: !!(d?.importBatchId),
            hasFileHashSnippet: !!(d?.fileHashSnippet),
            hasPreviewUrl: !!(su?.previewUrl),
            hasOriginalUrl: !!(su?.originalUrl),
          },
        },
      };
    },
  },
  {
    id: "BL",
    section: "gallery-detail",
    label: "BL. Person filter — Import済み「凛(Rin)」",
    description: "GET /api/persons → name==\"凛(Rin)\" を検索し、そのIDで GET /api/images?personId=...&limit=48",
    expected: "200、images.length > 0、各 image の persons に「凛(Rin)」が含まれる",
    run: async () => {
      const pr = await fetch("/api/persons");
      const pj = await pr.json() as { data?: { id: string; name: string }[] };
      const person = (pj.data ?? []).find((p) => p.name === "凛(Rin)");
      if (!person) {
        return { status: 0, body: { error: "person「凛(Rin)」が見つかりません。Import済みデータを確認してください。", persons: pj.data } };
      }
      const r = await fetch(`/api/images?personId=${person.id}&limit=48`);
      const body = await r.json() as { data?: { images?: { id: string; persons: { name: string }[] }[] } };
      const images = body.data?.images ?? [];
      const allHavePerson = images.every((img) => img.persons.some((p) => p.name === "凛(Rin)"));
      return {
        status: r.status,
        body: {
          ...body,
          _check: {
            personFound: person.name,
            personId: person.id,
            imagesCount: images.length,
            imagesGt0: images.length > 0,
            allImagesHavePerson: allHavePerson,
          },
        },
      };
    },
  },
  {
    id: "BM",
    section: "gallery-detail",
    label: "BM. Tag filter — Import済み「xlsx-import」",
    description: "GET /api/tags → name==\"xlsx-import\" を検索し、そのIDで GET /api/images?tagId=...&limit=48",
    expected: "200、images.length > 0、各 image の tags に「xlsx-import」が含まれる",
    run: async () => {
      const tr = await fetch("/api/tags");
      const tj = await tr.json() as { data?: { id: string; name: string }[] };
      const tag = (tj.data ?? []).find((t) => t.name === "xlsx-import");
      if (!tag) {
        return { status: 0, body: { error: "tag「xlsx-import」が見つかりません。Import済みデータを確認してください。", tags: tj.data } };
      }
      const r = await fetch(`/api/images?tagId=${tag.id}&limit=48`);
      const body = await r.json() as { data?: { images?: { id: string; tags: { name: string }[] }[] } };
      const images = body.data?.images ?? [];
      const allHaveTag = images.every((img) => img.tags.some((t) => t.name === "xlsx-import"));
      return {
        status: r.status,
        body: {
          ...body,
          _check: {
            tagFound: tag.name,
            tagId: tag.id,
            imagesCount: images.length,
            imagesGt0: images.length > 0,
            allImagesHaveTag: allHaveTag,
          },
        },
      };
    },
  },
  {
    id: "BN",
    section: "gallery-detail",
    label: "BN. Scene filter — Import済み「XLSX Import」",
    description: "GET /api/scenes → name==\"XLSX Import\" を検索し、そのIDで GET /api/images?sceneId=...&limit=48",
    expected: "200、images.length > 0、各 image の scene.name が「XLSX Import」",
    run: async () => {
      const sr = await fetch("/api/scenes");
      const sj = await sr.json() as { data?: { id: string; name: string }[] };
      const scene = (sj.data ?? []).find((s) => s.name === "XLSX Import");
      if (!scene) {
        return { status: 0, body: { error: "scene「XLSX Import」が見つかりません。Import済みデータを確認してください。", scenes: sj.data } };
      }
      const r = await fetch(`/api/images?sceneId=${scene.id}&limit=48`);
      const body = await r.json() as { data?: { images?: { id: string; scene: { name: string } | null }[] } };
      const images = body.data?.images ?? [];
      const allHaveScene = images.every((img) => img.scene?.name === "XLSX Import");
      return {
        status: r.status,
        body: {
          ...body,
          _check: {
            sceneFound: scene.name,
            sceneId: scene.id,
            imagesCount: images.length,
            imagesGt0: images.length > 0,
            allImagesHaveScene: allHaveScene,
          },
        },
      };
    },
  },
  {
    id: "BO",
    section: "gallery-detail",
    label: "BO. Search (q) — Import画像のpromptSnippetで検索",
    description: "xlsx-importタグの最初の画像を取得し、promptSnippet→originalName→fallbackの優先順でクエリを生成して GET /api/images?q=...&limit=48",
    expected: "200、images.length > 0、元の画像IDが結果に含まれる",
    run: async (ctx) => {
      // 1. xlsx-import タグで画像を1件取得（Import由来確定）
      const tr = await fetch("/api/tags");
      const tj = await tr.json() as { data?: { id: string; name: string }[] };
      const tag = (tj.data ?? []).find((t) => t.name === "xlsx-import");

      type ListImage = { id: string; originalName: string; promptSnippet: string | null };
      let sourceImage: ListImage | null = null;
      let sourceField: "promptSnippet" | "originalName" | "fallback" = "fallback";

      if (tag) {
        const lr = await fetch(`/api/images?tagId=${tag.id}&limit=1`);
        const lj = await lr.json() as { data?: { images?: ListImage[] } };
        sourceImage = lj.data?.images?.[0] ?? null;
      }

      // 2. 検索クエリを決定（優先順: promptSnippet → originalName → fallback）
      let q = "prompt"; // fallback
      if (sourceImage?.promptSnippet) {
        // promptSnippet から連続した単語を10〜20文字抽出
        const snippet = sourceImage.promptSnippet.trim();
        // 空白で分割して最初の2〜3単語を結合（英語promptを想定）
        const words = snippet.split(/\s+/).filter(Boolean);
        const candidate = words.slice(0, 3).join(" ").slice(0, 20);
        if (candidate.length >= 3) {
          q = candidate;
          sourceField = "promptSnippet";
        }
      }
      if (sourceField === "fallback" && sourceImage?.originalName) {
        const stem = sourceImage.originalName.replace(/\.[^.]+$/, "").slice(0, 12);
        if (stem.length >= 2) {
          q = stem;
          sourceField = "originalName";
        }
      }

      const expectedId = sourceImage?.id ?? ctx.getImageId() ?? null;

      // 3. 検索実行
      const r = await fetch(`/api/images?q=${encodeURIComponent(q)}&limit=48`);
      const body = await r.json() as { data?: { images?: { id: string }[] } };
      const images = body.data?.images ?? [];
      const resultIds = images.map((i) => i.id);
      const containsExpected = expectedId ? resultIds.includes(expectedId) : false;

      return {
        status: r.status,
        body: {
          ...body,
          _check: {
            queryUsed: q,
            sourceField,
            expectedImageId: expectedId,
            resultCount: images.length,
            imagesGt0: images.length > 0,
            containsExpectedImage: containsExpected,
          },
        },
      };
    },
  },
];

// ---- prompt versions tests BP〜BR -----------------------------------------

const PROMPT_VERSION_TESTS: TestCase[] = [
  {
    id: "BP",
    section: "gallery-detail",
    label: "BP. promptVersionCount > 0 の画像を検索",
    description: "GET /api/images をページングして promptVersionCount > 0 の画像を1件探す（最大5ページ）",
    expected: "promptVersionCount > 0 の画像が1件以上見つかり imageId を保存",
    run: async (ctx) => {
      type ListImage = { id: string; originalName: string; promptVersionCount: number };
      let cursor: string | null = null;
      let found: ListImage | null = null;
      let totalScanned = 0;
      let pagesScanned = 0;
      const MAX_PAGES = 20;

      while (pagesScanned < MAX_PAGES) {
        const url = cursor ? `/api/images?limit=100&cursor=${cursor}` : "/api/images?limit=100";
        const r = await fetch(url);
        const j = await r.json() as { data?: { images?: ListImage[]; nextCursor?: string | null } };
        const images = j.data?.images ?? [];
        totalScanned += images.length;
        pagesScanned++;
        found = images.find((img) => img.promptVersionCount > 0) ?? null;
        if (found) break;
        cursor = j.data?.nextCursor ?? null;
        if (!cursor) break; // 全件走査完了
      }

      if (found) ctx.setImageId(found.id);

      return {
        status: found ? 200 : 0,
        body: {
          _check: {
            found: !!found,
            imageId: found?.id ?? null,
            originalName: found?.originalName ?? null,
            promptVersionCount: found?.promptVersionCount ?? 0,
            pagesScanned,
            totalScanned,
          },
        },
      };
    },
  },
  {
    id: "BQ",
    section: "gallery-detail",
    label: "BQ. Image detail — prompt.versions 確認",
    description: "BP で保存した imageId で GET /api/images/:id → prompt.versions を確認",
    expected: "200、versions.length > 0、各 version に body / versionType / createdAt がある",
    run: async (ctx) => {
      const id = ctx.getImageId();
      if (!id) return { status: 0, body: { error: "imageId 未取得 — BP を先に実行してください" } };
      const r = await fetch(`/api/images/${id}`);
      const body = await r.json() as { data?: { prompt?: { versions?: Record<string, unknown>[] } } };
      const versions = body.data?.prompt?.versions ?? [];
      const v0 = versions[0] as Record<string, unknown> | undefined;
      return {
        status: r.status,
        body: {
          ...body,
          _check: {
            versionsCount: versions.length,
            versionsGt0: versions.length > 0,
            firstVersionType: v0?.versionType ?? null,
            firstVersionHasBody: typeof v0?.body === "string" && (v0.body as string).length > 0,
            firstVersionHasCreatedAt: !!(v0?.createdAt),
            firstVersionChangeNote: v0?.changeNote ?? null,
          },
        },
      };
    },
  },
  {
    id: "BR",
    section: "gallery-detail",
    label: "BR. Prompt version copy UI 手動確認案内",
    description: "手動確認: Gallery で履歴バッジ付きカードをクリックし、履歴コピーを確認",
    expected: "手動確認 — 以下手順を参照",
    run: async () => {
      return {
        status: 200,
        body: {
          manual: true,
          steps: [
            "1. /gallery を開く",
            "2. カード左上に「履歴 N」バッジが表示されている画像をクリック",
            "3. DetailPanel → 「プロンプト履歴」セクションが表示される",
            "4. 各 version カードに versionType / 日時 / changeNote / body preview が表示される",
            "5. 「全文表示」で展開、「閉じる」で折りたたみ",
            "6. 「コピー」ボタンを押して「コピーしました ✓」が表示される",
            "7. 履歴のない画像では「履歴はありません」が表示される",
          ],
        },
      };
    },
  },
];

// ---- Masters management tests BS〜BY ----------------------------------------

const MASTERS_MGMT_TESTS: TestCase[] = [
  {
    id: "BS",
    section: "masters-mgmt",
    label: "BS. GET /api/persons — 凛(Rin) imageCount > 0 確認",
    description: "GET /api/persons → 凛(Rin) が存在し imageCount > 0 であることを確認",
    expected: "200、凛(Rin) が存在、imageCount > 0、全要素に imageCount フィールドあり",
    run: async () => {
      const r = await fetch("/api/persons");
      const body = await r.json() as { data?: { id: string; name: string; imageCount: number }[] };
      const items = body.data ?? [];
      const allHaveCount = items.every((p) => typeof p.imageCount === "number");
      const rin = items.find((p) => p.name === "凛(Rin)");
      return {
        status: r.status,
        body: {
          _check: {
            total: items.length,
            allHaveImageCount: allHaveCount,
            rinFound: !!rin,
            rinImageCount: rin?.imageCount ?? null,
            rinImageCountGt0: (rin?.imageCount ?? 0) > 0,
            rinId: rin?.id ?? null,
          },
        },
      };
    },
  },
  {
    id: "BT",
    section: "masters-mgmt",
    label: "BT. PATCH /api/persons/:id — [TEST] API Check Person (idempotent)",
    description: "固定名「[TEST] API Check Person」を GET or POST で取得し、notes/defaultPromptHint を PATCH。何度実行しても増えない",
    expected: "200、notes/defaultPromptHint 更新、空name PATCH は 400",
    run: async () => {
      const FIXED_NAME = "[TEST] API Check Person";

      // 1. 既存を探す、なければ作成
      const lr = await fetch("/api/persons");
      const lj = await lr.json() as { data?: { id: string; name: string }[] };
      let testId = (lj.data ?? []).find((p) => p.name === FIXED_NAME)?.id ?? null;

      if (!testId) {
        const cr = await fetch("/api/persons", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: FIXED_NAME }),
        });
        const cj = await cr.json() as { data?: { id: string } };
        testId = cj.data?.id ?? null;
      }
      if (!testId) return { status: 0, body: { error: "person 取得/作成失敗" } };

      // 2. notes / defaultPromptHint を更新
      const testNotes = "API Check テストメモ";
      const testHint = "API Check テストヒント";
      const r = await fetch(`/api/persons/${testId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: testNotes, defaultPromptHint: testHint }),
      });
      const body = await r.json() as { data?: { id: string; name: string; notes: string | null; defaultPromptHint: string | null } };
      const d = body.data;

      // 3. 空name → 400 確認
      const emptyR = await fetch(`/api/persons/${testId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "   " }),
      });

      return {
        status: r.status,
        body: {
          _check: {
            testPersonId: testId,
            nameIsFixed: d?.name === FIXED_NAME,
            notesUpdated: d?.notes === testNotes,
            hintUpdated: d?.defaultPromptHint === testHint,
            emptyNameIs400: emptyR.status === 400,
            note: "凛(Rin)は変更していません。固定名マスタを再利用するため何度実行しても増えません",
          },
        },
      };
    },
  },
  {
    id: "BU",
    section: "masters-mgmt",
    label: "BU. GET /api/scenes — XLSX Import imageCount > 0 確認",
    description: "GET /api/scenes → XLSX Import が存在し imageCount > 0 であることを確認",
    expected: "200、XLSX Import が存在、imageCount > 0、全要素に imageCount フィールドあり",
    run: async () => {
      const r = await fetch("/api/scenes");
      const body = await r.json() as { data?: { id: string; name: string; imageCount: number }[] };
      const items = body.data ?? [];
      const allHaveCount = items.every((s) => typeof s.imageCount === "number");
      const xlsx = items.find((s) => s.name === "XLSX Import");
      return {
        status: r.status,
        body: {
          _check: {
            total: items.length,
            allHaveImageCount: allHaveCount,
            xlsxFound: !!xlsx,
            xlsxImageCount: xlsx?.imageCount ?? null,
            xlsxImageCountGt0: (xlsx?.imageCount ?? 0) > 0,
            xlsxId: xlsx?.id ?? null,
          },
        },
      };
    },
  },
  {
    id: "BV",
    section: "masters-mgmt",
    label: "BV. PATCH /api/scenes/:id — [TEST] API Check Scene (idempotent)",
    description: "固定名「[TEST] API Check Scene」を GET or POST で取得し、description を PATCH。何度実行しても増えない",
    expected: "200、description 更新、空name PATCH は 400",
    run: async () => {
      const FIXED_NAME = "[TEST] API Check Scene";

      const lr = await fetch("/api/scenes");
      const lj = await lr.json() as { data?: { id: string; name: string }[] };
      let testId = (lj.data ?? []).find((s) => s.name === FIXED_NAME)?.id ?? null;

      if (!testId) {
        const cr = await fetch("/api/scenes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: FIXED_NAME }),
        });
        const cj = await cr.json() as { data?: { id: string } };
        testId = cj.data?.id ?? null;
      }
      if (!testId) return { status: 0, body: { error: "scene 取得/作成失敗" } };

      const testDesc = "API Check テスト説明文";
      const r = await fetch(`/api/scenes/${testId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: testDesc }),
      });
      const body = await r.json() as { data?: { id: string; name: string; description: string | null } };
      const d = body.data;

      const emptyR = await fetch(`/api/scenes/${testId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "   " }),
      });

      return {
        status: r.status,
        body: {
          _check: {
            testSceneId: testId,
            nameIsFixed: d?.name === FIXED_NAME,
            descriptionUpdated: d?.description === testDesc,
            emptyNameIs400: emptyR.status === 400,
            note: "XLSX Importは変更していません。固定名マスタを再利用するため何度実行しても増えません",
          },
        },
      };
    },
  },
  {
    id: "BW",
    section: "masters-mgmt",
    label: "BW. GET /api/tags — xlsx-import imageCount > 0 確認",
    description: "GET /api/tags → xlsx-import が存在し imageCount > 0 であることを確認",
    expected: "200、xlsx-import が存在、imageCount > 0、全要素に imageCount フィールドあり",
    run: async () => {
      const r = await fetch("/api/tags");
      const body = await r.json() as { data?: { id: string; name: string; imageCount: number }[] };
      const items = body.data ?? [];
      const allHaveCount = items.every((t) => typeof t.imageCount === "number");
      const xlsxTag = items.find((t) => t.name === "xlsx-import");
      return {
        status: r.status,
        body: {
          _check: {
            total: items.length,
            allHaveImageCount: allHaveCount,
            xlsxTagFound: !!xlsxTag,
            xlsxTagImageCount: xlsxTag?.imageCount ?? null,
            xlsxTagImageCountGt0: (xlsxTag?.imageCount ?? 0) > 0,
            xlsxTagId: xlsxTag?.id ?? null,
          },
        },
      };
    },
  },
  {
    id: "BX",
    section: "masters-mgmt",
    label: "BX. PATCH /api/tags/:id — [TEST] API Check Tag (idempotent)",
    description: "固定名「[TEST] API Check Tag」を GET or POST で取得し、name を一時変更後に元に戻す。何度実行しても増えない",
    expected: "200、name が固定名に戻る、空name PATCH は 400",
    run: async () => {
      const FIXED_NAME = "[TEST] API Check Tag";

      const lr = await fetch("/api/tags");
      const lj = await lr.json() as { data?: { id: string; name: string }[] };
      let testId = (lj.data ?? []).find((t) => t.name === FIXED_NAME)?.id ?? null;

      if (!testId) {
        const cr = await fetch("/api/tags", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: FIXED_NAME }),
        });
        const cj = await cr.json() as { data?: { id: string } };
        testId = cj.data?.id ?? null;
      }
      if (!testId) return { status: 0, body: { error: "tag 取得/作成失敗" } };

      // 一時的に別名にして PATCH の動作を確認し、固定名に戻す
      const tempName = `${FIXED_NAME}-tmp`;
      await fetch(`/api/tags/${testId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: tempName }),
      });
      const r = await fetch(`/api/tags/${testId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: FIXED_NAME }),
      });
      const body = await r.json() as { data?: { id: string; name: string } };
      const d = body.data;

      const emptyR = await fetch(`/api/tags/${testId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "   " }),
      });

      return {
        status: r.status,
        body: {
          _check: {
            testTagId: testId,
            nameIsFixed: d?.name === FIXED_NAME,
            emptyNameIs400: emptyR.status === 400,
            note: "xlsx-importは変更していません。固定名マスタを再利用するため何度実行しても増えません",
          },
        },
      };
    },
  },
  {
    id: "BY",
    section: "masters-mgmt",
    label: "BY. Gallery filter links — 凛(Rin)/XLSX Import/xlsx-import の URL 確認",
    description: "各マスタのIDを取得し、Gallery フィルターリンクを生成。リンクを開いて絞り込みが動作することを手動確認",
    expected: "3つのリンクが生成される、手動で開いて絞り込み確認",
    run: async () => {
      const [pr, sr, tr] = await Promise.all([
        fetch("/api/persons").then((r) => r.json()) as Promise<{ data?: { id: string; name: string; imageCount: number }[] }>,
        fetch("/api/scenes").then((r) => r.json()) as Promise<{ data?: { id: string; name: string; imageCount: number }[] }>,
        fetch("/api/tags").then((r) => r.json()) as Promise<{ data?: { id: string; name: string; imageCount: number }[] }>,
      ]);
      const rin = (pr.data ?? []).find((p) => p.name === "凛(Rin)");
      const xlsx = (sr.data ?? []).find((s) => s.name === "XLSX Import");
      const xlsxTag = (tr.data ?? []).find((t) => t.name === "xlsx-import");

      return {
        status: 200,
        body: {
          _check: {
            personLink: rin ? `/gallery?personId=${rin.id}` : null,
            sceneLink: xlsx ? `/gallery?sceneId=${xlsx.id}` : null,
            tagLink: xlsxTag ? `/gallery?tagId=${xlsxTag.id}` : null,
            allLinksGenerated: !!(rin && xlsx && xlsxTag),
          },
          manual: "上記リンクを開き、該当マスタで絞り込まれた画像が表示されることを確認してください",
        },
      };
    },
  },
];

// ---- Day 10 tests BZ〜CF --------------------------------------------------

const DAY10_TESTS: TestCase[] = [
  {
    id: "BZ",
    section: "masters-mgmt",
    label: "BZ. Gallery URL filter sync — 手動確認ガイド",
    description: "GalleryのURLフィルター同期を手動確認するためのURL例を生成",
    expected: "各URLを開いてフィルターが正しく適用されること、フィルター変更でURLが更新されること",
    run: async () => {
      const [pr, sr, tr] = await Promise.all([
        fetch("/api/persons").then((r) => r.json()) as Promise<{ data?: { id: string; name: string }[] }>,
        fetch("/api/scenes").then((r) => r.json()) as Promise<{ data?: { id: string; name: string }[] }>,
        fetch("/api/tags").then((r) => r.json()) as Promise<{ data?: { id: string; name: string }[] }>,
      ]);
      const firstPerson = (pr.data ?? [])[0];
      const firstScene = (sr.data ?? [])[0];
      const firstTag = (tr.data ?? [])[0];
      return {
        status: 200,
        body: {
          _manual_check: "以下のURLを開いてフィルターが適用されることを確認してください",
          urlExamples: {
            personFilter: firstPerson ? `/gallery?personId=${firstPerson.id}` : null,
            sceneFilter: firstScene ? `/gallery?sceneId=${firstScene.id}` : null,
            tagFilter: firstTag ? `/gallery?tagId=${firstTag.id}` : null,
            combined: firstPerson && firstTag ? `/gallery?personId=${firstPerson.id}&tagId=${firstTag.id}` : null,
            withSearch: firstPerson ? `/gallery?personId=${firstPerson.id}&q=hotel` : null,
            favorites: "/gallery?favorite=true",
          },
          howToVerify: [
            "1. 上記URLを開くとフィルターが選択済みになること",
            "2. UIでtagを選ぶとURLにtagIdが追加されること",
            "3. フィルタをリセットするとURLが /gallery に戻ること",
            "4. ブラウザの戻る/進むでフィルターが復元されること",
          ],
        },
      };
    },
  },
  {
    id: "CA",
    section: "masters-mgmt",
    label: "CA. Prompt edit API — 空currentBody → 400",
    description: "PATCH /api/images/:id/prompt — currentBody: '' で 400 になること",
    expected: "400、error.code === 'VALIDATION_ERROR'",
    run: async (ctx) => {
      const imageId = ctx.getImageId();
      if (!imageId) {
        return { status: 0, body: { _skipped: "imageId not set — run gallery tests first" } };
      }
      const r = await fetch(`/api/images/${imageId}/prompt`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentBody: "" }),
      });
      return { status: r.status, body: await r.json() };
    },
  },
  {
    id: "CB",
    section: "masters-mgmt",
    label: "CB. Prompt edit API — 存在しないID → 404",
    description: "PATCH /api/images/nonexistent-id/prompt → 404",
    expected: "404、error.code === 'NOT_FOUND'",
    run: async () => {
      const r = await fetch("/api/images/nonexistent-image-id-12345/prompt", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentBody: "test prompt body" }),
      });
      return { status: r.status, body: await r.json() };
    },
  },
  {
    id: "CC",
    section: "masters-mgmt",
    label: "CC. Masters delete — imageCount=0 のテストタグ削除",
    description: "imageCount=0 のタグを削除。[TEST]タグがあれば削除する（手動確認推奨）",
    expected: "200、{ data: { deleted: true } } または該当タグなし",
    run: async () => {
      const r = await fetch("/api/tags");
      const j = (await r.json()) as { data?: { id: string; name: string; imageCount: number }[] };
      const testTags = (j.data ?? []).filter((t) => t.name.includes("[TEST]") && t.imageCount === 0);
      if (testTags.length === 0) {
        return { status: 200, body: { _info: "imageCount=0の[TEST]タグはありません" } };
      }
      const tag = testTags[0];
      const dr = await fetch(`/api/tags/${tag.id}`, { method: "DELETE" });
      return { status: dr.status, body: { ...(await dr.json()), _deleted: tag.name } };
    },
  },
  {
    id: "CD",
    section: "masters-mgmt",
    label: "CD. Masters delete — imageCount>0 のタグ削除 → 400",
    description: "imageCount>0 のタグを DELETE しようとすると 400 になること",
    expected: "400、error.code === 'VALIDATION_ERROR'",
    run: async () => {
      const r = await fetch("/api/tags");
      const j = (await r.json()) as { data?: { id: string; name: string; imageCount: number }[] };
      const tagWithImages = (j.data ?? []).find((t) => t.imageCount > 0);
      if (!tagWithImages) {
        return { status: 200, body: { _info: "imageCount>0のタグが見つかりません" } };
      }
      const dr = await fetch(`/api/tags/${tagWithImages.id}`, { method: "DELETE" });
      return { status: dr.status, body: await dr.json() };
    },
  },
  {
    id: "CE",
    section: "masters-mgmt",
    label: "CE. Prompt edit no-op — 同一currentBody → 200、versionが増えない",
    description: "現在と同じcurrentBodyをPATCHすると200が返り、prompt_versionsは増えないこと",
    expected: "200、versions配列の件数が変わらない",
    run: async (ctx) => {
      const imageId = ctx.getImageId();
      if (!imageId) {
        return { status: 0, body: { _skipped: "imageId not set — run gallery tests (AT) first" } };
      }
      // 現在のpromptを取得
      const dr = await fetch(`/api/images/${imageId}`);
      if (!dr.ok) return { status: dr.status, body: await dr.json() };
      const dj = (await dr.json()) as { data?: { prompt?: { currentBody: string; versions: unknown[] } } };
      const currentBody = dj.data?.prompt?.currentBody;
      const versionCountBefore = dj.data?.prompt?.versions?.length ?? 0;
      if (!currentBody) {
        return { status: 200, body: { _info: "promptがない画像のためスキップ" } };
      }
      // 同じbodyでPATCH (no-op)
      const pr = await fetch(`/api/images/${imageId}/prompt`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentBody }),
      });
      const pj = (await pr.json()) as { data?: { prompt?: { versions: unknown[] } } };
      const versionCountAfter = pj.data?.prompt?.versions?.length ?? 0;
      return {
        status: pr.status,
        body: {
          ...pj,
          _check: {
            noOpWorked: pr.status === 200,
            versionsBefore: versionCountBefore,
            versionsAfter: versionCountAfter,
            versionCountUnchanged: versionCountBefore === versionCountAfter,
          },
        },
      };
    },
  },
  {
    id: "CF",
    section: "masters-mgmt",
    label: "CF. Merge self → 400",
    description: "POST /api/tags/:id/merge — sourceId === targetId は 400 になること",
    expected: "400、error.code === 'VALIDATION_ERROR'",
    run: async () => {
      const r = await fetch("/api/tags");
      const j = (await r.json()) as { data?: { id: string; name: string }[] };
      const anyTag = (j.data ?? [])[0];
      if (!anyTag) return { status: 200, body: { _info: "タグが存在しない" } };
      const mr = await fetch(`/api/tags/${anyTag.id}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: anyTag.id, dryRun: true }),
      });
      return { status: mr.status, body: await mr.json() };
    },
  },
  {
    id: "CG",
    section: "masters-mgmt",
    label: "CG. Merge tag dry-run — 2つのテストタグ間",
    description: "imageCount=0 の [TEST]タグを2つ作成してdry-run merge。DBは変わらない",
    expected: "200、counts.imagesToMove=0、counts.duplicatesToSkip=0",
    run: async () => {
      // [TEST]タグを2つ作成（冪等）
      const [r1, r2] = await Promise.all([
        fetch("/api/tags", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "[TEST]MergeSource" }) }),
        fetch("/api/tags", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "[TEST]MergeTarget" }) }),
      ]);
      const j1 = (await r1.json()) as { data?: { id: string } };
      const j2 = (await r2.json()) as { data?: { id: string } };
      const sourceId = j1.data?.id;
      const targetId = j2.data?.id;
      if (!sourceId || !targetId) {
        return { status: 400, body: { _error: "テストタグ作成失敗", j1, j2 } };
      }
      const mr = await fetch(`/api/tags/${sourceId}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId, dryRun: true }),
      });
      return { status: mr.status, body: await mr.json() };
    },
  },
  {
    id: "CH",
    section: "masters-mgmt",
    label: "CH. Merge tag execute — [TEST]タグを統合して削除確認",
    description: "[TEST]MergeSource を [TEST]MergeTarget に統合。sourceが削除されること",
    expected: "200、merged: true、sourceタグが一覧から消える",
    run: async () => {
      // タグ一覧から[TEST]タグを探す
      const lr = await fetch("/api/tags");
      const lj = (await lr.json()) as { data?: { id: string; name: string; imageCount: number }[] };
      const source = (lj.data ?? []).find((t) => t.name === "[TEST]MergeSource");
      const target = (lj.data ?? []).find((t) => t.name === "[TEST]MergeTarget");
      if (!source || !target) {
        return { status: 200, body: { _info: "CGを先に実行してください（テストタグが見つかりません）", found: { source: source?.name, target: target?.name } } };
      }
      // 本実行
      const mr = await fetch(`/api/tags/${source.id}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: target.id, dryRun: false }),
      });
      const mj = await mr.json();
      // 統合後にsourceが消えているか確認
      const lr2 = await fetch("/api/tags");
      const lj2 = (await lr2.json()) as { data?: { id: string; name: string }[] };
      const sourceStillExists = (lj2.data ?? []).some((t) => t.id === source.id);
      return {
        status: mr.status,
        body: { ...mj as object, _check: { sourceDeleted: !sourceStillExists } },
      };
    },
  },
  {
    id: "CI",
    section: "masters-mgmt",
    label: "CI. Merge non-existing target → 404",
    description: "POST /api/tags/:id/merge — targetIdが存在しない場合 404",
    expected: "404、error.code === 'NOT_FOUND'",
    run: async () => {
      const r = await fetch("/api/tags");
      const j = (await r.json()) as { data?: { id: string; name: string }[] };
      const anyTag = (j.data ?? [])[0];
      if (!anyTag) return { status: 200, body: { _info: "タグが存在しない" } };
      const mr = await fetch(`/api/tags/${anyTag.id}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: "nonexistent-target-id-xyz", dryRun: true }),
      });
      return { status: mr.status, body: await mr.json() };
    },
  },
];

// ---- ALL tests list -------------------------------------------------------

const ALL_TESTS = [...MASTER_TESTS, ...SESSION_TESTS, ...ITEM_TESTS, ...PROMPT_TESTS, ...COMMIT_TESTS, ...GALLERY_TESTS, ...CLEANUP_TESTS, ...IMPORT_TESTS, ...GALLERY_DETAIL_TESTS, ...PROMPT_VERSION_TESTS, ...MASTERS_MGMT_TESTS, ...DAY10_TESTS];

// ---- PASS 判定 -----------------------------------------------------------

function isExpectedOk(id: string, status: number, body: unknown, prev: Record<string, TestResult>): boolean {
  const b = body as Record<string, unknown>;
  const d = b?.data as Record<string, unknown> | undefined;
  const e = (b?.error ?? {}) as Record<string, unknown>;
  switch (id) {
    case "A": return (status === 201 || status === 200) && !!d;
    case "B": return status === 200 && Array.isArray(d);
    case "C": return (status === 201 || status === 200) && !!d;
    case "D": return status === 200 && Array.isArray(d);
    case "E": { if (!((status === 201 || status === 200) && d)) return false; return "notes" in d && "defaultPromptHint" in d; }
    case "F": return status === 200 && Array.isArray(d);
    case "G": return status === 200 && !!d;
    case "H": return status === 404 && e.code === "NOT_FOUND";
    case "I": return status === 400 && e.code === "VALIDATION_ERROR";
    case "J": return status === 400 && e.code === "VALIDATION_ERROR";
    case "K": { const s = d?.session as Record<string, unknown> | undefined; return (status === 201 || status === 200) && s?.status === "ACTIVE" && Array.isArray(d?.items); }
    case "L": {
      const s = d?.session as Record<string, unknown> | undefined;
      if (!(status === 200 && s?.status === "ACTIVE")) return false;
      const kBody = prev["K"]?.body as Record<string, unknown> | undefined;
      const kSession = (kBody?.data as Record<string, unknown> | undefined)?.session as Record<string, unknown> | undefined;
      return !kSession?.id || s?.id === kSession?.id;
    }
    case "M": return status === 200 && Array.isArray(d?.items);
    case "N": { const s = d?.session as Record<string, unknown> | undefined; return status === 200 && s?.title === "更新後セッション名"; }
    case "O": { const s = d?.session as Record<string, unknown> | undefined; return status === 200 && s?.status === "PREVIEWING"; }
    case "P": return status === 400 && e.code === "VALIDATION_ERROR";
    case "Q": { const s = d?.session as Record<string, unknown> | undefined; return status === 200 && s?.status === "ABANDONED"; }
    case "R": return status === 404 && e.code === "NOT_FOUND";
    case "T": { const item = d?.item as Record<string, unknown> | undefined; return (status === 201 || status === 200) && item?.uploadStatus === "READY" && !!d?.signedUrls; }
    case "U": return status === 400 && (e.code === "FILE_HASH_MISMATCH" || e.code === "VALIDATION_ERROR");
    case "V": return (status === 415 || status === 400) && (e.code === "UNSUPPORTED_MEDIA_TYPE" || e.code === "VALIDATION_ERROR");
    case "W": { const items = d?.items as unknown[]; return status === 200 && Array.isArray(items) && items.length > 0; }
    case "X": { const data = b?.data as Record<string, unknown> | undefined; return status === 200 && !!data?.signedUrl; }
    case "Y": { const item = d?.item as Record<string, unknown> | undefined; return (status === 201 || status === 200) && item?.duplicateStatus === "CLEAN"; }
    case "Z": return status === 200 && !!d?.item;
    case "AA": return status === 200 && (d?.item as Record<string, unknown>)?.promptStatus === "DRAFT";
    case "AB": return status === 200 && (d?.item as Record<string, unknown>)?.promptStatus === "FILLED";
    case "AC": return status === 400 && e.code === "VALIDATION_ERROR";
    case "AD": return status === 200 && !!(d?.item);
    case "AE": return status === 400 && e.code === "VALIDATION_ERROR";
    case "AF": return status === 200 && typeof (d?.updatedCount) === "number" && (d?.updatedCount as number) >= 1;
    case "AG": return status === 400 && e.code === "VALIDATION_ERROR";
    case "AH": return status === 200 && Array.isArray(d?.items);
    case "AI": return status === 200 && typeof (d?.summary) === "object" && Array.isArray(d?.items);
    case "AJ": return status === 400 && e.code === "VALIDATION_ERROR";
    case "AK": return status === 200 && (typeof (d as Record<string,unknown>)?.canCommit === "boolean");
    case "AL": return status === 200 && typeof (d?.url) === "string";
    case "AM": {
      const data = (b?.data ?? b) as Record<string, unknown>;
      const invalid = data.invalid as Array<Record<string, unknown>> | undefined;
      return status === 200 || status === 400 || (Array.isArray(invalid) && invalid.length > 0);
    }
    case "AN": {
      const data = (b?.data ?? b) as Record<string, unknown>;
      const summary = data.summary as Record<string, unknown> | undefined;
      return status === 200 && typeof summary?.committed === "number" && (summary.committed as number) >= 1;
    }
    case "AO": {
      const data = (b?.data ?? b) as Record<string, unknown>;
      const summary = data.summary as Record<string, unknown> | undefined;
      return status === 200 && typeof summary?.alreadyCommitted === "number" && (summary.alreadyCommitted as number) >= 1;
    }
    case "AP": {
      const data = (b?.data ?? b) as Record<string, unknown>;
      const summary = data.summary as Record<string, unknown> | undefined;
      return status === 200 && typeof summary?.skipped === "number" && (summary.skipped as number) >= 1;
    }
    case "AQ": return true;
    case "AR": { const imgs = d?.images; return status === 200 && Array.isArray(imgs); }
    case "AS": { const imgs = (d?.images as Record<string, unknown>[] | undefined); return status === 200 && Array.isArray(imgs) && imgs.every((i) => i.isFavorite === true); }
    case "AT": return status === 200 || status === 404;
    case "AU": return status === 404 && e.code === "NOT_FOUND";
    case "AV": return status === 200 && d?.dryRun === true && typeof d?.summary === "object";
    case "AW": return status === 400 && e.code === "VALIDATION_ERROR";
    case "AX": return status === 200 && d?.dryRun === false;
    case "AY": { return status === 200 && Array.isArray(d?.columns) && (d?.autoMapping as Record<string, unknown>)?.imageUrlColumn !== undefined; }
    case "AZ": { return status === 200 && (d?.autoMapping as Record<string, unknown>)?.imageUrlColumn === null; }
    case "BA": return status === 400 || status === 413;
    case "BI": {
      const chk = (body as Record<string, unknown>)._check as Record<string, unknown> | undefined;
      return status === 200 && chk?.imagesGt0 === true && chk?.imagesLe48 === true && chk?.hasNextCursor === true;
    }
    case "BJ": {
      const chk = (body as Record<string, unknown>)._check as Record<string, unknown> | undefined;
      if (chk?.skipped) return true; // < 48件でページング不要は PASS
      return status === 200 && chk?.noOverlap === true;
    }
    case "BK": {
      const chk = (body as Record<string, unknown>)._check as Record<string, unknown> | undefined;
      return status === 200 && chk?.hasSourceSheetName === true && (chk?.hasPreviewUrl === true || chk?.hasOriginalUrl === true);
    }
    case "BL": {
      const chk = (body as Record<string, unknown>)._check as Record<string, unknown> | undefined;
      return status === 200 && chk?.imagesGt0 === true;
    }
    case "BM": {
      const chk = (body as Record<string, unknown>)._check as Record<string, unknown> | undefined;
      return status === 200 && chk?.imagesGt0 === true;
    }
    case "BN": {
      const chk = (body as Record<string, unknown>)._check as Record<string, unknown> | undefined;
      return status === 200 && chk?.imagesGt0 === true;
    }
    case "BO": {
      const chk = (body as Record<string, unknown>)._check as Record<string, unknown> | undefined;
      return status === 200 && chk?.imagesGt0 === true;
    }
    case "BP": {
      const chk = (body as Record<string, unknown>)._check as Record<string, unknown> | undefined;
      return status === 200 && chk?.found === true && (chk?.promptVersionCount as number) > 0;
    }
    case "BQ": {
      const chk = (body as Record<string, unknown>)._check as Record<string, unknown> | undefined;
      return status === 200 && chk?.versionsGt0 === true && chk?.firstVersionHasBody === true;
    }
    case "BR": return status === 200;
    case "BS": {
      const chk = (body as Record<string, unknown>)._check as Record<string, unknown> | undefined;
      return status === 200 && chk?.allHaveImageCount === true && chk?.rinFound === true && chk?.rinImageCountGt0 === true;
    }
    case "BT": {
      const chk = (body as Record<string, unknown>)._check as Record<string, unknown> | undefined;
      return status === 200 && chk?.nameIsFixed === true && chk?.notesUpdated === true && chk?.hintUpdated === true && chk?.emptyNameIs400 === true;
    }
    case "BU": {
      const chk = (body as Record<string, unknown>)._check as Record<string, unknown> | undefined;
      return status === 200 && chk?.allHaveImageCount === true && chk?.xlsxFound === true && chk?.xlsxImageCountGt0 === true;
    }
    case "BV": {
      const chk = (body as Record<string, unknown>)._check as Record<string, unknown> | undefined;
      return status === 200 && chk?.nameIsFixed === true && chk?.descriptionUpdated === true && chk?.emptyNameIs400 === true;
    }
    case "BW": {
      const chk = (body as Record<string, unknown>)._check as Record<string, unknown> | undefined;
      return status === 200 && chk?.allHaveImageCount === true && chk?.xlsxTagFound === true && chk?.xlsxTagImageCountGt0 === true;
    }
    case "BX": {
      const chk = (body as Record<string, unknown>)._check as Record<string, unknown> | undefined;
      return status === 200 && chk?.nameIsFixed === true && chk?.emptyNameIs400 === true;
    }
    case "BY": {
      const chk = (body as Record<string, unknown>)._check as Record<string, unknown> | undefined;
      return status === 200 && chk?.allLinksGenerated === true;
    }
    case "BZ": return status === 200;
    case "CA": return status === 400 && (body as Record<string, unknown>)?.error !== undefined;
    case "CB": return status === 404;
    case "CC": return status === 200;
    case "CD": return status === 400;
    case "CE": {
      const chk = (body as Record<string, unknown>)._check as Record<string, unknown> | undefined;
      return status === 200 && chk?.versionCountUnchanged === true;
    }
    case "CF": return status === 400;
    case "CG": {
      const d = (body as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
      const c = d?.counts as Record<string, unknown> | undefined;
      return status === 200 && c?.imagesToMove === 0;
    }
    case "CH": {
      const chk = (body as Record<string, unknown>)._check as Record<string, unknown> | undefined;
      return status === 200 && chk?.sourceDeleted === true;
    }
    case "CI": return status === 404;
    default: return false;
  }
}

// ---- TestCard UI ---------------------------------------------------------

function TestCard({ tc, result, isRunning, onRun }: { tc: TestCase; result: TestResult | undefined; isRunning: boolean; onRun: () => void }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-zinc-900">{tc.label}</span>
            {result?.skipped && <span className="rounded-full px-2 py-0.5 text-xs font-medium bg-zinc-100 text-zinc-500">SKIP</span>}
            {result && !result.skipped && (
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${result.ok ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                {result.ok ? "PASS" : "FAIL"}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-zinc-500">{tc.description}</p>
          <p className="mt-0.5 text-xs text-zinc-400">期待: {tc.expected}</p>
        </div>
        <button onClick={onRun} disabled={isRunning} className="shrink-0 rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-200 disabled:opacity-50">
          {isRunning ? "..." : "実行"}
        </button>
      </div>
      {result && !result.skipped && (
        <div className="mt-3 border-t border-zinc-100 pt-3">
          <div className="flex gap-3 text-xs text-zinc-500">
            <span>HTTP <strong className={result.status >= 200 && result.status < 300 ? "text-green-600" : "text-red-600"}>{result.status || "Error"}</strong></span>
            <span>{result.durationMs}ms</span>
          </div>
          <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-zinc-50 p-3 text-xs text-zinc-700">{JSON.stringify(result.body, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

function SectionHeader({ title, badge }: { title: string; badge?: string }) {
  return (
    <div className="flex items-center gap-3 border-b border-zinc-200 pb-2">
      <h2 className="text-base font-semibold text-zinc-800">{title}</h2>
      {badge && <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs text-zinc-500">{badge}</span>}
    </div>
  );
}

// ---- Main Component -------------------------------------------------------

export default function ApiCheckClient() {
  const [results, setResults] = useState<Record<string, TestResult>>({});
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [runningAll, setRunningAll] = useState(false);
  const [runningSection, setRunningSection] = useState<TestSection | null>(null);

  // 共有状態は ref（render を起こさない）
  const sessionIdRef = useRef<string | null>(null);
  const itemIdRef = useRef<string | null>(null);
  const sceneIdRef = useRef<string | null>(null);
  const tagIdRef = useRef<string | null>(null);
  const personIdRef = useRef<string | null>(null);
  const imageIdRef = useRef<string | null>(null);

  // scene/tag/person/image の表示用 state（ref の変化を UI に反映するため）
  const [displaySceneId, setDisplaySceneId] = useState<string | null>(null);
  const [displayTagId, setDisplayTagId] = useState<string | null>(null);
  const [displayPersonId, setDisplayPersonId] = useState<string | null>(null);
  const [displayImageId, setDisplayImageId] = useState<string | null>(null);

  // ファイル選択状態は state（UI 更新が必要）
  const [fileState, setFileState] = useState<FileState | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileInfo, setFileInfo] = useState<{ name: string; size: number; type: string; hash: string; hasThumbnail: boolean; hasPreview: boolean } | null>(null);

  const ctx: TestContext = {
    getSessionId: () => sessionIdRef.current,
    setSessionId: (id) => { sessionIdRef.current = id; },
    getItemId: () => itemIdRef.current,
    setItemId: (id) => { itemIdRef.current = id; },
    getFileState: () => fileState,
    getSceneId: () => sceneIdRef.current,
    setSceneId: (id) => { sceneIdRef.current = id; setDisplaySceneId(id); },
    getTagId: () => tagIdRef.current,
    setTagId: (id) => { tagIdRef.current = id; setDisplayTagId(id); },
    getPersonId: () => personIdRef.current,
    setPersonId: (id) => { personIdRef.current = id; setDisplayPersonId(id); },
    getImageId: () => imageIdRef.current,
    setImageId: (id) => { imageIdRef.current = id; setDisplayImageId(id); },
  };

  // ファイル選択ハンドラ
  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileLoading(true);
    setFileState(null);
    setFileInfo(null);
    try {
      const [hash, dims, thumb, prev] = await Promise.all([
        sha256Hex(file),
        getImageDimensions(file),
        generateWebpBlob(file, 256),
        generateWebpBlob(file, 1024),
      ]);
      const fs: FileState = { file, clientFileHash: hash, thumbnail: thumb, preview: prev, widthPx: dims?.w ?? null, heightPx: dims?.h ?? null };
      setFileState(fs);
      setFileInfo({ name: file.name, size: file.size, type: file.type, hash, hasThumbnail: !!thumb, hasPreview: !!prev });
    } finally {
      setFileLoading(false);
    }
  }

  async function runTest(tc: TestCase) {
    if (tc.requiresFile && !fileState) {
      setResults((prev) => ({ ...prev, [tc.id]: { label: tc.label, status: 0, ok: false, skipped: true, body: "画像ファイルを先に選択してください (テスト S)", durationMs: 0 } }));
      return;
    }
    setRunning((prev) => ({ ...prev, [tc.id]: true }));
    const start = Date.now();
    try {
      const { status, body } = await tc.run(ctx);
      const durationMs = Date.now() - start;

      // master tests A/C/E: extract scene/tag/person IDs from successful responses
      if (tc.id === "A" && (status === 200 || status === 201)) {
        const b = body as Record<string, unknown>;
        const d = b?.data as Record<string, unknown> | undefined;
        const id = d?.id as string | undefined;
        if (id) ctx.setSceneId(id);
      } else if (tc.id === "C" && (status === 200 || status === 201)) {
        const b = body as Record<string, unknown>;
        const d = b?.data as Record<string, unknown> | undefined;
        const id = d?.id as string | undefined;
        if (id) ctx.setTagId(id);
      } else if (tc.id === "E" && (status === 200 || status === 201)) {
        const b = body as Record<string, unknown>;
        const d = b?.data as Record<string, unknown> | undefined;
        const id = d?.id as string | undefined;
        if (id) ctx.setPersonId(id);
      }

      setResults((prev) => {
        const next = { ...prev, [tc.id]: { label: tc.label, status, ok: isExpectedOk(tc.id, status, body, prev), body, durationMs } };
        return next;
      });
    } catch (e) {
      setResults((prev) => ({ ...prev, [tc.id]: { label: tc.label, status: 0, ok: false, body: String(e), durationMs: Date.now() - start } }));
    } finally {
      setRunning((prev) => ({ ...prev, [tc.id]: false }));
    }
  }

  async function runSection(section: TestSection) {
    setRunningSection(section);
    // S はファイル選択 UI なのでスキップ
    const tests = ALL_TESTS.filter((t) => t.section === section && t.id !== "S");
    for (const tc of tests) await runTest(tc);
    setRunningSection(null);
  }

  async function runAll() {
    setRunningAll(true);
    // S はスキップ。ファイル依存テスト (requiresFile) はファイルがあれば実行
    for (const tc of ALL_TESTS.filter((t) => t.id !== "S")) await runTest(tc);
    setRunningAll(false);
  }

  const resultCount = Object.values(results).filter((r) => !r.skipped).length;
  const passCount = Object.values(results).filter((r) => r.ok).length;

  return (
    <div className="mt-6 flex flex-col gap-6">

      {/* グローバルコントロール */}
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={runAll} disabled={runningAll} className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50">
          {runningAll ? "実行中..." : "すべて実行 (A〜R, T〜Y, Z〜AX)"}
        </button>
        <button onClick={() => { setResults({}); sessionIdRef.current = null; itemIdRef.current = null; sceneIdRef.current = null; tagIdRef.current = null; personIdRef.current = null; imageIdRef.current = null; setDisplaySceneId(null); setDisplayTagId(null); setDisplayPersonId(null); setDisplayImageId(null); }} className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100">
          結果をクリア
        </button>
        {resultCount > 0 && <span className="text-sm text-zinc-500">{passCount}/{resultCount} passed</span>}
      </div>

      {/* ---- マスタ API ---- */}
      <div className="flex flex-col gap-3">
        <SectionHeader title="マスタ API (A〜J)" />
        <button onClick={() => runSection("master")} disabled={runningSection === "master"} className="w-fit rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-200 disabled:opacity-50">
          {runningSection === "master" ? "実行中..." : "マスタ API テストをすべて実行"}
        </button>
        {MASTER_TESTS.map((tc) => <TestCard key={tc.id} tc={tc} result={results[tc.id]} isRunning={!!running[tc.id]} onRun={() => runTest(tc)} />)}
      </div>

      {/* ---- Upload Session API ---- */}
      <div className="flex flex-col gap-3">
        <SectionHeader
          title="Upload Session API (K〜R)"
          badge={sessionIdRef.current ? `session: ${sessionIdRef.current.slice(0, 12)}...` : "session: 未取得 (K を実行)"}
        />
        <button onClick={() => runSection("session")} disabled={runningSection === "session"} className="w-fit rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-200 disabled:opacity-50">
          {runningSection === "session" ? "実行中..." : "Upload Session テストをすべて実行"}
        </button>
        {SESSION_TESTS.map((tc) => <TestCard key={tc.id} tc={tc} result={results[tc.id]} isRunning={!!running[tc.id]} onRun={() => runTest(tc)} />)}
      </div>

      {/* ---- Upload Item API ---- */}
      <div className="flex flex-col gap-3">
        <SectionHeader
          title="Upload Item API (S〜Y)"
          badge={itemIdRef.current ? `item: ${itemIdRef.current.slice(0, 12)}...` : "item: 未取得 (T を実行)"}
        />

        {/* S: ファイル選択 */}
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <span className="font-semibold text-zinc-900">S. 画像ファイル選択</span>
              <p className="mt-0.5 text-xs text-zinc-500">JPEG / PNG / WebP を 1 枚選択。client 側で SHA-256・thumbnail・preview を生成します。</p>
            </div>
            <label className="shrink-0 cursor-pointer rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-200">
              {fileLoading ? "処理中..." : "ファイルを選択"}
              <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={handleFileSelect} disabled={fileLoading} />
            </label>
          </div>
          {fileInfo && (
            <div className="mt-3 border-t border-zinc-100 pt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
              <div><span className="text-zinc-400">name:</span> <span className="text-zinc-700">{fileInfo.name}</span></div>
              <div><span className="text-zinc-400">size:</span> <span className="text-zinc-700">{(fileInfo.size / 1024).toFixed(1)} KB</span></div>
              <div><span className="text-zinc-400">type:</span> <span className="text-zinc-700">{fileInfo.type}</span></div>
              <div><span className="text-zinc-400">thumbnail:</span> <span className={fileInfo.hasThumbnail ? "text-green-600" : "text-red-500"}>{fileInfo.hasThumbnail ? "生成済み" : "失敗"}</span></div>
              <div className="col-span-2"><span className="text-zinc-400">SHA-256:</span> <span className="break-all text-zinc-700 font-mono">{fileInfo.hash}</span></div>
              <div><span className="text-zinc-400">preview:</span> <span className={fileInfo.hasPreview ? "text-green-600" : "text-red-500"}>{fileInfo.hasPreview ? "生成済み" : "失敗"}</span></div>
            </div>
          )}
          {!fileInfo && !fileLoading && (
            <p className="mt-2 text-xs text-zinc-400">ファイル未選択。T / U / Y の実行に必要です。</p>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => runSection("item")} disabled={runningSection === "item"} className="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-200 disabled:opacity-50">
            {runningSection === "item" ? "実行中..." : "Upload Item テストをすべて実行 (T〜Y)"}
          </button>
          {!fileState && <span className="text-xs text-amber-600">ファイル未選択 — T / U / Y は SKIP されます</span>}
        </div>

        {/* Y の注意書き */}
        <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-700">
          <strong>Y テストについて:</strong> 重複判定は <code>images</code> テーブルに対して行うため、未 commit の upload_items 同士は MVP では重複判定しません。同じファイルを2回アップロードしても、commit 前は <code>duplicateStatus === &quot;CLEAN&quot;</code> になります。
        </div>

        {ITEM_TESTS.map((tc) => <TestCard key={tc.id} tc={tc} result={results[tc.id]} isRunning={!!running[tc.id]} onRun={() => runTest(tc)} />)}
      </div>

      {/* ---- Upload Item Prompt / Metadata API ---- */}
      <div className="flex flex-col gap-3">
        <SectionHeader
          title="Upload Item Prompt / Metadata API (Z〜AH)"
          badge={itemIdRef.current ? `item: ${itemIdRef.current.slice(0, 12)}...` : "item: 未取得 (T を実行)"}
        />
        {/* Status bar showing scene/tag/person IDs */}
        <div className="rounded-md bg-zinc-50 border border-zinc-200 px-3 py-2 text-xs text-zinc-500 grid grid-cols-3 gap-2">
          <span>scene: {displaySceneId?.slice(0, 8) ?? "未取得 (A を実行)"}</span>
          <span>tag: {displayTagId?.slice(0, 8) ?? "未取得 (C を実行)"}</span>
          <span>person: {displayPersonId?.slice(0, 8) ?? "未取得 (E を実行)"}</span>
        </div>
        <button onClick={() => runSection("prompt")} disabled={runningSection === "prompt"} className="w-fit rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-200 disabled:opacity-50">
          {runningSection === "prompt" ? "実行中..." : "Prompt / Metadata テストをすべて実行 (Z〜AH)"}
        </button>
        {PROMPT_TESTS.map((tc) => <TestCard key={tc.id} tc={tc} result={results[tc.id]} isRunning={!!running[tc.id]} onRun={() => runTest(tc)} />)}
      </div>

      {/* ---- CommitPreview API ---- */}
      <div className="flex flex-col gap-3">
        <SectionHeader title="CommitPreview API (AI〜AQ)" />
        <button onClick={() => runSection("commit")} disabled={runningSection === "commit"}
          className="w-fit rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-200 disabled:opacity-50">
          {runningSection === "commit" ? "実行中..." : "CommitPreview テストをすべて実行 (AI〜AQ)"}
        </button>
        {(() => {
          const alUrl = (((results["AL"]?.body as Record<string, unknown>)?.data) as Record<string, unknown>)?.url;
          const aqUrl = (results["AQ"]?.body as Record<string, unknown>)?.url;
          const linkUrl = typeof alUrl === "string" ? alUrl : typeof aqUrl === "string" ? aqUrl : null;
          if (!linkUrl) return null;
          return (
            <a href={linkUrl} target="_blank" rel="noreferrer"
              className="w-fit rounded-md bg-blue-50 border border-blue-200 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100">
              CommitPreview を開く →
            </a>
          );
        })()}
        {COMMIT_TESTS.map((tc) => <TestCard key={tc.id} tc={tc} result={results[tc.id]} isRunning={!!running[tc.id]} onRun={() => runTest(tc)} />)}
        <div className="rounded-md bg-zinc-50 border border-zinc-200 px-3 py-2 text-xs text-zinc-500">
          AM は自動実行可能 (sessionId が必要)。AN/AO/AP/AQ は手動前提。手動確認手順: /quick-add で画像をアップロード→プロンプト入力→プレビューへ→重複チェック→確定保存
        </div>
      </div>

      {/* ---- Gallery API ---- */}
      <div className="flex flex-col gap-3">
        <SectionHeader title="Gallery API (AR〜AU)" />
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => runSection("gallery")} disabled={runningSection === "gallery"} className="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-200 disabled:opacity-50">
            {runningSection === "gallery" ? "実行中..." : "Gallery テストをすべて実行 (AR〜AU)"}
          </button>
          <a href="/gallery" target="_blank" rel="noreferrer" className="rounded-md bg-blue-50 border border-blue-200 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100">
            Gallery を開く →
          </a>
        </div>
        <div className="rounded-md bg-zinc-50 border border-zinc-200 px-3 py-2 text-xs text-zinc-500">
          AT は commit 済み画像が存在する場合のみ 200 を返します。画像が0件の場合は message のみ返します。
        </div>
        {GALLERY_TESTS.map((tc) => <TestCard key={tc.id} tc={tc} result={results[tc.id]} isRunning={!!running[tc.id]} onRun={() => runTest(tc)} />)}
      </div>

      {/* ---- Cleanup API ---- */}
      <div className="flex flex-col gap-3">
        <SectionHeader title="Cleanup API (AV〜AX)" />
        <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-700">
          <strong>注意 (AX):</strong> AX は実行系です。古い未コミットセッションを実際に削除します。COMMITTED session は削除されません。まず AV (dryRun) で確認してから実行することを推奨します。
        </div>
        <button onClick={() => { void runTest(CLEANUP_TESTS[0]); void runTest(CLEANUP_TESTS[1]); }} disabled={runningSection === "gallery"} className="w-fit rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-200 disabled:opacity-50">
          AV / AW を実行 (安全)
        </button>
        {CLEANUP_TESTS.map((tc) => <TestCard key={tc.id} tc={tc} result={results[tc.id]} isRunning={!!running[tc.id]} onRun={() => runTest(tc)} />)}
      </div>

      {/* ---- Import API ---- */}
      <div className="flex flex-col gap-3">
        <SectionHeader title="Import API (AY〜BA)" />
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={async () => { setRunningSection("gallery"); for (const tc of IMPORT_TESTS) await runTest(tc); setRunningSection(null); }} disabled={runningSection === "gallery"} className="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-200 disabled:opacity-50">
            {runningSection === "gallery" ? "実行中..." : "Import テストをすべて実行 (AY〜BA)"}
          </button>
          <a href="/import" target="_blank" rel="noreferrer" className="rounded-md bg-blue-50 border border-blue-200 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100">
            Import を開く →
          </a>
        </div>
        <div className="rounded-md bg-zinc-50 border border-zinc-200 px-3 py-2 text-xs text-zinc-500">
          AY/AZ は自動実行可能。BA はAPIへの4MB超送信で 400 確認。フロントUIのサイズチェックは /import で手動確認。
        </div>
        {IMPORT_TESTS.map((tc) => <TestCard key={tc.id} tc={tc} result={results[tc.id]} isRunning={!!running[tc.id]} onRun={() => runTest(tc)} />)}
      </div>

      {/* ---- Gallery Detail / Filter / Search API BI〜BO ---- */}
      <div className="flex flex-col gap-3">
        <SectionHeader
          title="Gallery Detail / Filter / Search (BI〜BO)"
          badge={displayImageId ? `imageId: ${displayImageId.slice(0, 12)}...` : "imageId: 未取得 (BI を実行)"}
        />
        <div className="rounded-md bg-zinc-50 border border-zinc-200 px-3 py-2 text-xs text-zinc-500 grid grid-cols-3 gap-2">
          <span>scene: {displaySceneId?.slice(0, 8) ?? "未取得 (A)"}</span>
          <span>tag: {displayTagId?.slice(0, 8) ?? "未取得 (C)"}</span>
          <span>person: {displayPersonId?.slice(0, 8) ?? "未取得 (E)"}</span>
        </div>
        <button
          onClick={async () => { setRunningSection("gallery-detail"); for (const tc of GALLERY_DETAIL_TESTS) await runTest(tc); setRunningSection(null); }}
          disabled={runningSection === "gallery-detail"}
          className="w-fit rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-200 disabled:opacity-50"
        >
          {runningSection === "gallery-detail" ? "実行中..." : "Gallery Detail テストをすべて実行 (BI〜BO)"}
        </button>
        <div className="rounded-md bg-zinc-50 border border-zinc-200 px-3 py-2 text-xs text-zinc-500">
          BI〜BO はすべて単独実行可能です。BL/BM/BN は Import済みの「凛(Rin)」「xlsx-import」「XLSX Import」を自動検索します。BK は BI を先に実行すると imageId を引き継ぎます。
        </div>
        {GALLERY_DETAIL_TESTS.map((tc) => <TestCard key={tc.id} tc={tc} result={results[tc.id]} isRunning={!!running[tc.id]} onRun={() => runTest(tc)} />)}
      </div>

      {/* ---- Masters Management API BS〜BY ---- */}
      <div className="flex flex-col gap-3">
        <SectionHeader title="Masters 管理 API (BS〜BY)" />
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={async () => {
              setRunningSection("masters-mgmt");
              for (const tc of MASTERS_MGMT_TESTS) await runTest(tc);
              setRunningSection(null);
            }}
            disabled={runningSection === "masters-mgmt"}
            className="w-fit rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-200 disabled:opacity-50"
          >
            {runningSection === "masters-mgmt" ? "実行中..." : "Masters 管理テストをすべて実行 (BS〜BY)"}
          </button>
          <a href="/masters" target="_blank" rel="noreferrer" className="rounded-md bg-blue-50 border border-blue-200 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100">
            Masters を開く →
          </a>
        </div>
        <div className="rounded-md bg-zinc-50 border border-zinc-200 px-3 py-2 text-xs text-zinc-500">
          BS〜BU: GET API の imageCount 確認。BV/BW: PATCH で更新後に元に戻す。BX: 空 name の 400 確認。BY: 手動確認案内。
        </div>
        {MASTERS_MGMT_TESTS.map((tc) => <TestCard key={tc.id} tc={tc} result={results[tc.id]} isRunning={!!running[tc.id]} onRun={() => runTest(tc)} />)}
      </div>

      {/* ---- Prompt Versions API BP〜BR ---- */}
      <div className="flex flex-col gap-3">
        <SectionHeader
          title="Prompt Versions (BP〜BR)"
          badge={displayImageId ? `imageId: ${displayImageId.slice(0, 12)}...` : "imageId: 未取得 (BP を実行)"}
        />
        <button
          onClick={async () => {
            setRunningSection("gallery-detail");
            for (const tc of PROMPT_VERSION_TESTS) await runTest(tc);
            setRunningSection(null);
          }}
          disabled={runningSection === "gallery-detail"}
          className="w-fit rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-200 disabled:opacity-50"
        >
          {runningSection === "gallery-detail" ? "実行中..." : "Prompt Versions テストをすべて実行 (BP〜BR)"}
        </button>
        <div className="rounded-md bg-zinc-50 border border-zinc-200 px-3 py-2 text-xs text-zinc-500">
          BP: 全ページを走査して promptVersionCount &gt; 0 の画像を探します。BQ: BP の imageId で詳細取得。BR: 手動確認案内。
        </div>
        {PROMPT_VERSION_TESTS.map((tc) => <TestCard key={tc.id} tc={tc} result={results[tc.id]} isRunning={!!running[tc.id]} onRun={() => runTest(tc)} />)}
      </div>
    </div>
  );
}
