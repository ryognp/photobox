"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { MutableRefObject } from "react";
import type { LocalItem } from "./types";
import type { SignedUrls } from "@/lib/upload/uploadClient";
import { uploadFile } from "@/lib/upload/uploadClient";
import { shouldIgnoreArrowNav } from "@/lib/quick-add/keyboardNav";
import { MAX_ORIGINAL_BYTES, MAX_ORIGINAL_MB } from "@/lib/upload/uploadLimits";
import {
  loadStoredSession,
  saveSession,
  clearStoredSession,
  type StoredSession,
} from "@/lib/upload/sessionStore";
import {
  fetchScenes,
  fetchTags,
  fetchPersons,
  createScene as masterCreateScene,
  createTag as masterCreateTag,
  createPerson as masterCreatePerson,
  type Scene,
  type Tag,
  type Person,
} from "@/lib/quick-add/masterClient";
import QuickAddHeader from "./_components/QuickAddHeader";
import RestoreSessionBanner from "./_components/RestoreSessionBanner";
import UploadDropzone from "./_components/UploadDropzone";
import ItemStrip from "./_components/ItemStrip";
import PreviewPane from "./_components/PreviewPane";
import InputPane from "./_components/InputPane";

type Props = {
  userEmail: string;
  workspaceId: string;
  workspaceName: string;
};

type PendingRestore = StoredSession & {
  itemCount: number | null;
  sessionItems: Record<string, unknown>[];
};

const MAX_CONCURRENT = 2;
const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export default function QuickAddClient({ userEmail, workspaceId, workspaceName }: Props) {
  const [items, setItems] = useState<LocalItem[]>([]);
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [checkedClientIds, setCheckedClientIds] = useState<string[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pendingRestore, setPendingRestore] = useState<PendingRestore | null>(null);
  const [globalErrors, setGlobalErrors] = useState<string[]>([]);
  const [restoreLoading, setRestoreLoading] = useState(false);

  // Master data state
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [persons, setPersons] = useState<Person[]>([]);
  const [masterLoading, setMasterLoading] = useState(true); // true until first fetch completes
  const [masterError, setMasterError] = useState<string | null>(null);

  // Mutable refs — avoid useCallback circular deps
  const uploadingCount = useRef(0);
  const pendingFiles = useRef<File[]>([]);
  const sessionIdRef = useRef<string | null>(null);
  const itemsRef = useRef<LocalItem[]>(items);
  const selectedClientIdRef = useRef<string | null>(null);
  // workspaceId is a server-provided prop that never changes during the component lifetime
  const workspaceIdRef = useRef(workspaceId);

  // focusPromptRef: passed to InputPane so it can register its focus function
  const focusPromptRef: MutableRefObject<(() => void) | null> = useRef(null);
  // saveAndNextRef: Cmd/Ctrl+Enter が「保存して次へ」ボタンと同じ処理を呼ぶための窓口
  const saveAndNextRef: MutableRefObject<(() => void) | null> = useRef(null);

  // 選択中アイテム(ItemForm)の未保存変更・保存中フラグ。
  // InputPane からの通知 callback 内で ref(キーボードハンドラ/遷移ガード用の最新値)と
  // 表示用 state を同期的に同時更新する(effect を挟むと保存開始とガード有効化の間に
  // 隙間ができるため)。dirty は表示に使わないので ref のみ。
  const [isSelectedItemSaving, setIsSelectedItemSaving] = useState(false);
  const isDirtyRef = useRef(false);
  const isSavingRef = useRef(false);

  const handleSelectedItemDirtyChange = useCallback((dirty: boolean) => {
    isDirtyRef.current = dirty;
  }, []);

  const handleSelectedItemSavingChange = useCallback((saving: boolean) => {
    isSavingRef.current = saving;
    setIsSelectedItemSaving(saving);
  }, []);

  // Sync refs in effects (never during render per React Compiler rules)
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    selectedClientIdRef.current = selectedClientId;
  }, [selectedClientId]);

  // 画像切替・モード切替・プレビュー遷移など「今の入力内容を捨てて進む」操作の
  // 共通ガード。保存中は何もしない(保存完了までブロック)。未保存変更があれば
  // ネイティブ確認ダイアログを挟み、キャンセルなら何もしない。
  const requestTransition = useCallback((action: () => void) => {
    if (isSavingRef.current) return;
    if (isDirtyRef.current) {
      if (!window.confirm("未保存の変更があります。保存せずに移動しますか？")) return;
    }
    action();
  }, []);

  // Revoke object URLs on unmount
  useEffect(() => {
    return () => {
      itemsRef.current.forEach((item) => {
        if (item.previewObjectUrl) URL.revokeObjectURL(item.previewObjectUrl);
      });
    };
  }, []);

  // Restore check on mount
  useEffect(() => {
    const stored = loadStoredSession();
    if (!stored || stored.workspaceId !== workspaceIdRef.current) return;

    let cancelled = false;
    fetch(`/api/uploads/session/${stored.sessionId}`)
      .then(async (r) => {
        if (cancelled) return;
        if (!r.ok) { clearStoredSession(); return; }
        const json = (await r.json()) as {
          data: { session: Record<string, unknown>; items?: Record<string, unknown>[] };
        };
        if (cancelled) return;
        const session = json.data.session;
        const status = session.status as string;
        if (status === "ACTIVE" || status === "PREVIEWING") {
          setPendingRestore({
            sessionId: stored.sessionId,
            workspaceId: stored.workspaceId,
            itemCount: (json.data.items ?? []).length,
            sessionItems: json.data.items ?? [],
          });
        } else {
          clearStoredSession();
        }
      })
      .catch(() => {
        if (cancelled) return;
        clearStoredSession();
      });

    return () => { cancelled = true; };
  }, []); // workspaceIdRef.current is stable (prop never changes)

  // Load master data on mount
  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchScenes(), fetchTags(), fetchPersons()])
      .then(([s, t, p]) => {
        if (cancelled) return;
        setScenes(s);
        setTags(t);
        setPersons(p);
      })
      .catch((e) => {
        if (cancelled) return;
        setMasterError(e instanceof Error ? e.message : "マスタデータ取得に失敗");
      })
      .finally(() => {
        if (!cancelled) setMasterLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      const target = e.target as HTMLElement | null;
      const isInput = shouldIgnoreArrowNav(target?.tagName, target?.isContentEditable);

      if (meta && e.key === "s") {
        e.preventDefault();
        // Cmd+S: save as draft — InputPane handles via its own listener;
        // here we just focus the prompt so the user can see the state
        focusPromptRef.current?.();
        return;
      }

      if (meta && e.key === "Enter") {
        // IME変換中のEnterは preventDefault より前に判定して素通しする
        // (変換操作を妨げず、保存もadvanceも行わない)
        if (e.isComposing) return;
        e.preventDefault();
        if (e.repeat) return; // 押しっぱなしの自動リピートは補助的に無視
        if (isSavingRef.current) return; // 保存中の再実行は無視(正本はInputPane側の保存ロック)
        // 「保存して次へ」ボタンと同じ処理(InputPane側で登録)を呼ぶ。
        // 編集不可/Mode B/unmount時は null が登録されているため no-op。
        // 保存に成功した場合のみ、InputPane側が onSelectNext() で次へ進める。
        saveAndNextRef.current?.();
        return;
      }

      if (!isInput) {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          const currentItems = itemsRef.current;
          const currentId = selectedClientIdRef.current;
          const idx = currentItems.findIndex((i) => i.clientId === currentId);
          if (idx > 0) {
            const targetId = currentItems[idx - 1].clientId;
            requestTransition(() => setSelectedClientId(targetId));
          }
          return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          const currentItems = itemsRef.current;
          const currentId = selectedClientIdRef.current;
          const idx = currentItems.findIndex((i) => i.clientId === currentId);
          if (idx >= 0 && idx < currentItems.length - 1) {
            const targetId = currentItems[idx + 1].clientId;
            requestTransition(() => setSelectedClientId(targetId));
          }
          return;
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [requestTransition]);

  function updateItem(clientId: string, patch: Partial<LocalItem>) {
    setItems((prev) =>
      prev.map((item) => (item.clientId === clientId ? { ...item, ...patch } : item))
    );
  }

  async function ensureSession(): Promise<string> {
    if (sessionIdRef.current) return sessionIdRef.current;
    const r = await fetch("/api/uploads/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: workspaceIdRef.current }),
    });
    if (!r.ok) throw new Error("セッション作成に失敗しました");
    const json = (await r.json()) as { data: { session: { id: string } } };
    const newId = json.data.session.id;
    saveSession({ sessionId: newId, workspaceId: workspaceIdRef.current });
    sessionIdRef.current = newId;
    setSessionId(newId);
    return newId;
  }

  function drainQueue() {
    while (uploadingCount.current < MAX_CONCURRENT && pendingFiles.current.length > 0) {
      const next = pendingFiles.current.shift();
      if (!next) break;
      const clientId = crypto.randomUUID();
      const newItem: LocalItem = {
        clientId,
        file: next,
        status: "queued",
        error: null,
        previewObjectUrl: null,
        serverId: null,
        serverItem: null,
        signedUrls: null,
      };
      setItems((prev) => [...prev, newItem]);
      setSelectedClientId((prev) => prev ?? clientId);
      void processFile(next, clientId);
    }
  }

  async function processFile(file: File, clientId: string) {
    uploadingCount.current += 1;
    try {
      const sid = await ensureSession();
      const result = await uploadFile(file, sid, (progress) => {
        const stage = progress.stage;
        if (stage !== "done" && stage !== "error") {
          updateItem(clientId, { status: stage });
        }
      });

      updateItem(clientId, {
        status: "done",
        serverId: result.item.id as string,
        serverItem: result.item,
        signedUrls: result.signedUrls,
        previewObjectUrl: result.previewObjectUrl,
      });
      setSelectedClientId(clientId);
      setTimeout(() => {
        focusPromptRef.current?.();
      }, 100);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "アップロードに失敗しました";
      updateItem(clientId, { status: "error", error: msg });
    } finally {
      uploadingCount.current -= 1;
      drainQueue();
    }
  }

  function handleFiles(files: File[]) {
    const errors: string[] = [];
    const valid: File[] = [];
    for (const f of files) {
      if (!ACCEPTED_TYPES.has(f.type)) {
        errors.push(`${f.name}: サポートされていないファイル形式です (JPEG/PNG/WebP のみ)`);
        continue;
      }
      if (f.size > MAX_ORIGINAL_BYTES) {
        errors.push(`${f.name}: ファイルサイズが ${MAX_ORIGINAL_MB}MB を超えています`);
        continue;
      }
      valid.push(f);
    }
    if (errors.length > 0) setGlobalErrors((prev) => [...prev, ...errors]);
    if (valid.length > 0) {
      pendingFiles.current.push(...valid);
      drainQueue();
    }
  }

  async function handleRestore() {
    if (!pendingRestore) return;
    setRestoreLoading(true);
    try {
      const restoredItems: LocalItem[] = pendingRestore.sessionItems.map((si) => ({
        clientId: crypto.randomUUID(),
        file: null,
        status: "done" as const,
        error: null,
        previewObjectUrl: null,
        serverId: si.id as string,
        serverItem: si,
        signedUrls: null,
      }));

      sessionIdRef.current = pendingRestore.sessionId;
      setSessionId(pendingRestore.sessionId);
      setItems(restoredItems);
      if (restoredItems.length > 0) setSelectedClientId(restoredItems[0].clientId);

      // Fetch signed URLs for all restored items
      const requests = restoredItems
        .filter((item) => item.serverId)
        .map((item, index) => ({ type: "uploadItem", id: item.serverId, variant: "preview", index }));

      if (requests.length > 0) {
        const r = await fetch("/api/storage/signed-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requests }),
        });
        if (r.ok) {
          const json = (await r.json()) as {
            data: { results: Array<{ id: string; signedUrl: string | null; fallback: string | null }> };
          };
          const results = json.data?.results ?? [];
          setItems((prev) =>
            prev.map((item) => {
              const match = results.find((res) => res.id === item.serverId);
              if (!match) return item;
              const signedUrls: SignedUrls = {
                thumbnail: { signedUrl: null, fallback: null },
                preview: { signedUrl: match.signedUrl, fallback: match.fallback },
                original: { signedUrl: null, fallback: null },
              };
              return { ...item, signedUrls };
            })
          );
        }
      }

      setPendingRestore(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "復元に失敗しました";
      setGlobalErrors((prev) => [...prev, msg]);
    } finally {
      setRestoreLoading(false);
    }
  }

  async function handleDiscard() {
    if (!pendingRestore) return;
    setRestoreLoading(true);
    try {
      await fetch(`/api/uploads/session/${pendingRestore.sessionId}`, { method: "DELETE" });
      clearStoredSession();
    } catch { /* ignore */ }
    setPendingRestore(null);
    setRestoreLoading(false);
  }

  function handleNavigate(direction: "prev" | "next") {
    setSelectedClientId((prev) => {
      const currentItems = itemsRef.current;
      const idx = currentItems.findIndex((i) => i.clientId === prev);
      if (direction === "prev" && idx > 0) return currentItems[idx - 1].clientId;
      if (direction === "next" && idx < currentItems.length - 1) return currentItems[idx + 1].clientId;
      return prev;
    });
  }

  function handleToggleCheck(clientId: string) {
    setCheckedClientIds((prev) =>
      prev.includes(clientId) ? prev.filter((id) => id !== clientId) : [...prev, clientId]
    );
  }

  function handleItemUpdated(serverItem: Record<string, unknown>) {
    const id = serverItem.id as string;
    setItems((prev) =>
      prev.map((item) => (item.serverId === id ? { ...item, serverItem } : item))
    );
  }

  function handleBulkUpdated(serverItems: Record<string, unknown>[]) {
    setItems((prev) =>
      prev.map((item) => {
        const updated = serverItems.find((si) => si.id === item.serverId);
        return updated ? { ...item, serverItem: updated } : item;
      })
    );
  }

  function handleSceneCreated(s: Scene) {
    setScenes((prev) => [...prev, s]);
  }

  function handleTagCreated(t: Tag) {
    setTags((prev) => [...prev, t]);
  }

  function handlePersonCreated(p: Person) {
    setPersons((prev) => [...prev, p]);
  }

  async function handleCreateScene(name: string): Promise<Scene> {
    try {
      const scene = await masterCreateScene(name);
      handleSceneCreated(scene);
      return scene;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "シーン作成に失敗しました";
      setGlobalErrors((prev) => [...prev, msg]);
      throw err;
    }
  }

  async function handleCreateTag(name: string): Promise<Tag> {
    try {
      const tag = await masterCreateTag(name);
      handleTagCreated(tag);
      return tag;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "タグ作成に失敗しました";
      setGlobalErrors((prev) => [...prev, msg]);
      throw err;
    }
  }

  async function handleCreatePerson(name: string): Promise<Person> {
    try {
      const person = await masterCreatePerson(name);
      handlePersonCreated(person);
      return person;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "人物作成に失敗しました";
      setGlobalErrors((prev) => [...prev, msg]);
      throw err;
    }
  }

  function handleSelectNext() {
    const currentItems = itemsRef.current;
    const currentId = selectedClientIdRef.current;
    const idx = currentItems.findIndex((i) => i.clientId === currentId);
    if (idx >= 0 && idx < currentItems.length - 1) {
      setSelectedClientId(currentItems[idx + 1].clientId);
    }
  }

  const selectedItem = items.find((i) => i.clientId === selectedClientId) ?? null;

  const router = useRouter();

  // QuickAddHeader の Gallery/Masters/Import 共通の遷移窓口(Phase 10-41-B)。
  // dirty/saving判定を複製せず requestTransition() をそのまま再利用する。
  const handleHeaderNavigate = useCallback((href: string) => {
    requestTransition(() => router.push(href));
  }, [requestTransition, router]);

  async function handleGoToPreview() {
    if (!sessionId || items.length === 0) return;
    try {
      // PATCH session status to PREVIEWING
      const r = await fetch(`/api/uploads/session/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "PREVIEWING" }),
      });
      if (!r.ok) {
        const json = await r.json().catch(() => ({})) as { error?: { message?: string } };
        setGlobalErrors(prev => [...prev, json.error?.message ?? "セッション更新に失敗しました"]);
        return;
      }
      router.push(`/quick-add/commit?sessionId=${sessionId}`);
    } catch {
      setGlobalErrors(prev => [...prev, "プレビューへの移動に失敗しました"]);
    }
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-50">
      <QuickAddHeader
        workspaceName={workspaceName}
        userEmail={userEmail}
        itemCount={items.length}
        sessionId={sessionId}
        isSaving={isSelectedItemSaving}
        onNavigate={handleHeaderNavigate}
      />
      {pendingRestore && (
        <RestoreSessionBanner
          sessionId={pendingRestore.sessionId}
          itemCount={pendingRestore.itemCount}
          onRestore={() => void handleRestore()}
          onDiscard={() => void handleDiscard()}
          isLoading={restoreLoading}
        />
      )}
      {(globalErrors.length > 0 || masterError) && (
        <div className="flex items-start gap-3 border-b border-red-200 bg-red-50 px-4 py-2">
          <ul className="flex-1 space-y-0.5 text-xs text-red-700">
            {masterError && <li>{masterError}</li>}
            {globalErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
          <button
            onClick={() => { setGlobalErrors([]); setMasterError(null); }}
            className="text-xs text-red-500 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1"
          >
            ✕
          </button>
        </div>
      )}
      <div className="flex shrink-0 items-center justify-end border-b border-zinc-200 bg-white px-4 py-1.5">
        <button
          onClick={() => requestTransition(() => void handleGoToPreview())}
          disabled={!sessionId || items.length === 0 || isSelectedItemSaving}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1"
        >
          プレビューへ →
        </button>
      </div>
      <main id="main-content" className="flex flex-1 overflow-hidden">
        {/* Left pane */}
        <div className="flex w-64 flex-col overflow-hidden border-r border-zinc-200 bg-white">
          <UploadDropzone onFiles={handleFiles} />
          <ItemStrip
            items={items}
            selectedClientId={selectedClientId}
            onSelect={(clientId) => {
              if (clientId === selectedClientId) return;
              requestTransition(() => setSelectedClientId(clientId));
            }}
            checkedClientIds={checkedClientIds}
            onToggleCheck={handleToggleCheck}
            disabled={isSelectedItemSaving}
          />
        </div>
        {/* Center pane */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <PreviewPane
            selectedItem={selectedItem}
            items={items}
            onNavigate={(direction) => requestTransition(() => handleNavigate(direction))}
            disabled={isSelectedItemSaving}
          />
        </div>
        {/* Right pane */}
        <div
          className="flex flex-col overflow-hidden border-l border-zinc-200 bg-white"
          style={{ width: "360px" }}
        >
          {masterLoading ? (
            <div className="flex flex-1 items-center justify-center">
              <span className="text-xs text-zinc-400">読み込み中…</span>
            </div>
          ) : (
            <InputPane
              selectedItem={selectedItem}
              checkedClientIds={checkedClientIds}
              items={items}
              sessionId={sessionId}
              scenes={scenes}
              tags={tags}
              persons={persons}
              onItemUpdated={handleItemUpdated}
              onBulkUpdated={handleBulkUpdated}
              onSceneCreated={handleSceneCreated}
              onTagCreated={handleTagCreated}
              onPersonCreated={handlePersonCreated}
              createScene={handleCreateScene}
              createTag={handleCreateTag}
              createPerson={handleCreatePerson}
              focusRef={focusPromptRef}
              onSelectNext={handleSelectNext}
              onDirtyChange={handleSelectedItemDirtyChange}
              onSavingChange={handleSelectedItemSavingChange}
              saveAndNextRef={saveAndNextRef}
            />
          )}
        </div>
      </main>
    </div>
  );
}
