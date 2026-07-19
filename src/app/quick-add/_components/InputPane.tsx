"use client";

import { useState, useEffect, useRef, useId } from "react";
import type { LocalItem } from "../types";
import type { Scene, Tag, Person } from "@/lib/quick-add/masterClient";
import { saveItemPrompt, updateItemMetadata } from "@/lib/quick-add/itemClient";
import MetaForm from "./MetaForm";
import BulkPromptPanel from "./BulkPromptPanel";

type Props = {
  selectedItem: LocalItem | null;
  checkedClientIds: string[];
  items: LocalItem[];
  sessionId: string | null;
  scenes: Scene[];
  tags: Tag[];
  persons: Person[];
  onItemUpdated: (serverItem: Record<string, unknown>) => void;
  onBulkUpdated: (serverItems: Record<string, unknown>[]) => void;
  onSceneCreated: (s: Scene) => void;
  onTagCreated: (t: Tag) => void;
  onPersonCreated: (p: Person) => void;
  createScene: (name: string) => Promise<Scene>;
  createTag: (name: string) => Promise<Tag>;
  createPerson: (name: string) => Promise<Person>;
  focusRef?: React.MutableRefObject<(() => void) | null>;
  onSelectNext: () => void;
};

type SaveState = "saving" | "saved" | "error" | null;
type Mode = "A" | "B";

function StatusBadge({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;

  const colorMap: Record<string, string> = {
    READY: "bg-green-100 text-green-700",
    PENDING: "bg-yellow-100 text-yellow-700",
    PROCESSING: "bg-blue-100 text-blue-700",
    COMMITTED: "bg-purple-100 text-purple-700",
    ERROR: "bg-red-100 text-red-700",
    DUPLICATE: "bg-orange-100 text-orange-700",
    filled: "bg-green-100 text-green-700",
    draft: "bg-zinc-100 text-zinc-600",
    empty: "bg-zinc-100 text-zinc-400",
  };

  const colorClass = colorMap[value] ?? "bg-zinc-100 text-zinc-500";

  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${colorClass}`}>
      {label}: {value}
    </span>
  );
}

// ---- ItemForm: inner form that resets state when key changes (key = serverId) ----

type ItemFormProps = Omit<Props, "checkedClientIds" | "items" | "sessionId" | "selectedItem"> & {
  item: LocalItem;
};

function ItemForm({
  item,
  scenes,
  tags,
  persons,
  onItemUpdated,
  onSceneCreated,
  onTagCreated,
  onPersonCreated,
  createScene,
  createTag,
  createPerson,
  focusRef,
  onSelectNext,
}: ItemFormProps) {
  const si = item.serverItem;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const promptLabelId = useId();

  // All state initialized from serverItem — resets automatically when key changes
  const [localPromptDraft, setLocalPromptDraft] = useState(
    (si?.promptDraft as string | null) ?? ""
  );
  const [localSceneId, setLocalSceneId] = useState<string | null>(
    (si?.sceneId as string | null) ?? null
  );
  const [localTagIds, setLocalTagIds] = useState<string[]>(
    (si?.tags as Array<{ tag: { id: string } }> | undefined)?.map((t) => t.tag.id) ?? []
  );
  const [localPersonIds, setLocalPersonIds] = useState<string[]>(
    (si?.persons as Array<{ person: { id: string } }> | undefined)?.map((p) => p.person.id) ?? []
  );
  const [localRating, setLocalRating] = useState<number | null>(
    (si?.rating as number | null) ?? null
  );
  const [localIsFavorite, setLocalIsFavorite] = useState(
    (si?.isFavorite as boolean) ?? false
  );
  const [localNotes, setLocalNotes] = useState((si?.notes as string | null) ?? "");

  const [promptSaveState, setPromptSaveState] = useState<SaveState>(null);
  const [promptSaveError, setPromptSaveError] = useState<string | null>(null);
  const [metaSaveState, setMetaSaveState] = useState<SaveState>(null);
  const [metaSaveError, setMetaSaveError] = useState<string | null>(null);

  // Register focus function
  useEffect(() => {
    if (focusRef) {
      focusRef.current = () => textareaRef.current?.focus();
      return () => { if (focusRef) focusRef.current = null; };
    }
  }, [focusRef]);

  // Auto-clear "saved" after 2s (only in callbacks, not directly)
  useEffect(() => {
    if (promptSaveState !== "saved") return;
    const t = setTimeout(() => setPromptSaveState(null), 2000);
    return () => clearTimeout(t);
  }, [promptSaveState]);

  useEffect(() => {
    if (metaSaveState !== "saved") return;
    const t = setTimeout(() => setMetaSaveState(null), 2000);
    return () => clearTimeout(t);
  }, [metaSaveState]);

  const isCommitted = si?.commitStatus === "COMMITTED";
  const isReady = si?.uploadStatus === "READY";
  const isDone = item.status === "done";
  const isEditable = isDone && isReady && !isCommitted;

  async function handleSaveDraft() {
    if (!item.serverId) return;
    setPromptSaveState("saving");
    setPromptSaveError(null);
    try {
      const updated = await saveItemPrompt(item.serverId, localPromptDraft, "draft");
      onItemUpdated(updated);
      setPromptSaveState("saved");
    } catch (e) {
      setPromptSaveError(e instanceof Error ? e.message : "保存に失敗しました");
      setPromptSaveState("error");
    }
  }

  async function handleSaveFilled() {
    if (!item.serverId) return;
    const draft = localPromptDraft.trim();
    if (!draft) { setPromptSaveError("プロンプトを入力してください"); setPromptSaveState("error"); return; }
    setPromptSaveState("saving");
    setPromptSaveError(null);
    try {
      const updated = await saveItemPrompt(item.serverId, draft, "filled");
      onItemUpdated(updated);
      setPromptSaveState("saved");
    } catch (e) {
      setPromptSaveError(e instanceof Error ? e.message : "保存に失敗しました");
      setPromptSaveState("error");
    }
  }

  async function handleSaveAndNext() {
    if (!item.serverId) return;
    const draft = localPromptDraft.trim();
    if (!draft) { setPromptSaveError("プロンプトを入力してください"); setPromptSaveState("error"); return; }
    setPromptSaveState("saving");
    setPromptSaveError(null);
    try {
      const updated = await saveItemPrompt(item.serverId, draft, "filled");
      onItemUpdated(updated);
      setPromptSaveState("saved");
      onSelectNext();
    } catch (e) {
      setPromptSaveError(e instanceof Error ? e.message : "保存に失敗しました");
      setPromptSaveState("error");
    }
  }

  async function handleSaveMeta() {
    if (!item.serverId) return;
    setMetaSaveState("saving");
    setMetaSaveError(null);
    try {
      const updated = await updateItemMetadata(item.serverId, {
        sceneId: localSceneId,
        tagIds: localTagIds,
        personIds: localPersonIds,
        rating: localRating,
        isFavorite: localIsFavorite,
        notes: localNotes.trim() || null,
      });
      onItemUpdated(updated);
      setMetaSaveState("saved");
    } catch (e) {
      setMetaSaveError(e instanceof Error ? e.message : "メタデータ保存に失敗しました");
      setMetaSaveState("error");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Status badges */}
      {si && (
        <div className="flex flex-wrap gap-1">
          <StatusBadge label="upload" value={si.uploadStatus as string | null} />
          <StatusBadge label="prompt" value={si.promptStatus as string | null} />
          <StatusBadge label="dup" value={si.duplicateStatus as string | null} />
          <StatusBadge label="commit" value={si.commitStatus as string | null} />
        </div>
      )}
      {isCommitted && (
        <p className="rounded bg-purple-50 px-2 py-1 text-xs font-medium text-purple-700">
          コミット済み (編集不可)
        </p>
      )}

      {/* Prompt */}
      <div className="flex flex-col gap-2">
        <label id={promptLabelId} className="text-xs font-semibold text-zinc-700">プロンプト</label>
        <textarea
          ref={textareaRef}
          aria-labelledby={promptLabelId}
          rows={7}
          value={localPromptDraft}
          onChange={(e) => { setLocalPromptDraft(e.target.value); setPromptSaveError(null); }}
          disabled={!isEditable}
          placeholder={!isDone ? "アップロード完了後に入力できます" : isCommitted ? "コミット済みのため編集できません" : "プロンプトを入力…"}
          className="resize-none rounded-md border border-zinc-200 px-3 py-2 text-xs text-zinc-800 placeholder-zinc-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-50"
        />
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void handleSaveDraft()} disabled={!isEditable || promptSaveState === "saving"}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1">
            下書き保存
          </button>
          <button type="button" onClick={() => void handleSaveFilled()} disabled={!isEditable || promptSaveState === "saving"}
            className="rounded-md border border-blue-300 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1">
            入力済みにする
          </button>
          <button type="button" onClick={() => void handleSaveAndNext()} disabled={!isEditable || promptSaveState === "saving"}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1">
            保存して次へ
          </button>
        </div>
        <div className="min-h-[16px]">
          {promptSaveState === "saving" && <p className="text-[10px] text-zinc-400">保存中…</p>}
          {promptSaveState === "saved" && <p className="text-[10px] text-green-600">保存しました ✓</p>}
          {promptSaveState === "error" && promptSaveError && <p className="text-[10px] text-red-500">{promptSaveError}</p>}
        </div>
      </div>

      <hr className="border-zinc-200" />

      {/* Metadata */}
      <div className="flex flex-col gap-3">
        <p className="text-xs font-semibold text-zinc-700">メタデータ</p>
        <MetaForm
          sceneId={localSceneId} tagIds={localTagIds} personIds={localPersonIds}
          rating={localRating} isFavorite={localIsFavorite} notes={localNotes}
          scenes={scenes} tags={tags} persons={persons} disabled={!isEditable}
          onSceneChange={setLocalSceneId} onTagsChange={setLocalTagIds} onPersonsChange={setLocalPersonIds}
          onRatingChange={setLocalRating} onFavoriteChange={setLocalIsFavorite} onNotesChange={setLocalNotes}
          onSceneCreated={onSceneCreated} onTagCreated={onTagCreated} onPersonCreated={onPersonCreated}
          createScene={createScene} createTag={createTag} createPerson={createPerson}
        />
        <button type="button" onClick={() => void handleSaveMeta()} disabled={!isEditable || metaSaveState === "saving"}
          className="self-start rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1">
          メタデータ保存
        </button>
        <div className="min-h-[16px]">
          {metaSaveState === "saving" && <p className="text-[10px] text-zinc-400">保存中…</p>}
          {metaSaveState === "saved" && <p className="text-[10px] text-green-600">保存しました ✓</p>}
          {metaSaveState === "error" && metaSaveError && <p className="text-[10px] text-red-500">{metaSaveError}</p>}
        </div>
      </div>
    </div>
  );
}

// ---- InputPane: outer shell handling mode tabs ----

export default function InputPane({
  selectedItem,
  checkedClientIds,
  items,
  sessionId,
  scenes,
  tags,
  persons,
  onItemUpdated,
  onBulkUpdated,
  onSceneCreated,
  onTagCreated,
  onPersonCreated,
  createScene,
  createTag,
  createPerson,
  focusRef,
  onSelectNext,
}: Props) {
  const [mode, setMode] = useState<Mode>("A");

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Mode tabs */}
      <div className="flex shrink-0 items-center gap-2 border-b border-zinc-200 px-4 py-2">
        <button type="button" onClick={() => setMode("A")}
          className={["rounded px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1", mode === "A" ? "bg-zinc-900 text-white" : "text-zinc-500 hover:bg-zinc-100"].join(" ")}>
          単体入力 (A)
        </button>
        <button type="button" onClick={() => setMode("B")}
          className={["rounded px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1", mode === "B" ? "bg-zinc-900 text-white" : "text-zinc-500 hover:bg-zinc-100"].join(" ")}>
          一括適用 (B)
        </button>
        {checkedClientIds.length > 0 && (
          <span className="ml-auto text-[10px] text-zinc-500">B: {checkedClientIds.length}枚選択中</span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {mode === "B" && (
          <BulkPromptPanel sessionId={sessionId} checkedClientIds={checkedClientIds} items={items} onSuccess={onBulkUpdated} />
        )}
        {mode === "A" && (
          selectedItem ? (
            // key resets all form state when selected item changes
            <ItemForm
              key={selectedItem.serverId ?? selectedItem.clientId}
              item={selectedItem}
              scenes={scenes} tags={tags} persons={persons}
              onItemUpdated={onItemUpdated} onBulkUpdated={onBulkUpdated}
              onSceneCreated={onSceneCreated} onTagCreated={onTagCreated} onPersonCreated={onPersonCreated}
              createScene={createScene} createTag={createTag} createPerson={createPerson}
              focusRef={focusRef} onSelectNext={onSelectNext}
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-zinc-400">アイテムを選択してください</p>
            </div>
          )
        )}
      </div>

      {/* Day 4-B label */}
      <div className="shrink-0 border-t border-zinc-100 px-4 py-1.5">
        <span className="text-[10px] text-zinc-300">Day 4-B 実装中</span>
      </div>
    </div>
  );
}
