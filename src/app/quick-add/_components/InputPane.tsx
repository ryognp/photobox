"use client";

import { useState, useEffect, useRef, useId } from "react";
import type { LocalItem } from "../types";
import type { Scene, Tag, Person } from "@/lib/quick-add/masterClient";
import { saveItemPrompt, updateItemMetadata } from "@/lib/quick-add/itemClient";
import type { SaveMode } from "@/lib/quick-add/itemClient";
import { isPromptDirty, isMetadataDirty, type PromptFields, type MetadataFields } from "@/lib/quick-add/itemDirty";
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
  // Phase 10-41-A: 未保存変更ガード + Cmd/Ctrl+Enter共通化のため追加
  onDirtyChange: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void;
  saveAndNextRef?: React.MutableRefObject<(() => void) | null>;
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
  onDirtyChange,
  onSavingChange,
  saveAndNextRef,
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

  // 保存済み基準値(baseline)。key変更でItemFormごと再マウントされるため、
  // 初期値はローカルstateの初期値と同じ(=マウント直後はclean)。
  // 保存成功時のみ、その保存処理が「リクエスト開始時に送信した値」で更新する
  // (通信完了時点の最新UI値ではない — 通信中の追加変更を dirty として残すため)。
  // render中に参照するため ref ではなく state で保持する(refをrender中に読むこと自体が禁止のため)。
  const [promptBaseline, setPromptBaseline] = useState<PromptFields>({
    promptDraft: (si?.promptDraft as string | null) ?? "",
  });
  const [metaBaseline, setMetaBaseline] = useState<MetadataFields>({
    sceneId: (si?.sceneId as string | null) ?? null,
    tagIds: (si?.tags as Array<{ tag: { id: string } }> | undefined)?.map((t) => t.tag.id) ?? [],
    personIds: (si?.persons as Array<{ person: { id: string } }> | undefined)?.map((p) => p.person.id) ?? [],
    rating: (si?.rating as number | null) ?? null,
    isFavorite: (si?.isFavorite as boolean) ?? false,
    notes: (si?.notes as string | null) ?? "",
  });

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

  // メタデータ(シーン/タグ/人物/評価/お気に入り/メモ)を保存する。
  // handleSaveMeta と saveCurrentItem の両方から共通で呼ばれる。
  async function saveCurrentMetadata(): Promise<boolean> {
    if (!item.serverId) return false;
    // リクエスト開始時点の値をスナップショットする。通信中にユーザーが値を
    // 変更しても、baseline は「実際に送信した値」のまま更新しない。
    const snapshot: MetadataFields = {
      sceneId: localSceneId,
      tagIds: localTagIds,
      personIds: localPersonIds,
      rating: localRating,
      isFavorite: localIsFavorite,
      notes: localNotes,
    };
    setMetaSaveState("saving");
    setMetaSaveError(null);
    try {
      const updated = await updateItemMetadata(item.serverId, {
        sceneId: snapshot.sceneId,
        tagIds: snapshot.tagIds,
        personIds: snapshot.personIds,
        rating: snapshot.rating,
        isFavorite: snapshot.isFavorite,
        notes: snapshot.notes.trim() || null,
      });
      onItemUpdated(updated);
      setMetaBaseline(snapshot);
      setMetaSaveState("saved");
      return true;
    } catch (e) {
      setMetaSaveError(e instanceof Error ? e.message : "メタデータ保存に失敗しました");
      setMetaSaveState("error");
      return false;
    }
  }

  // プロンプト本文を保存する。draft/filled いずれのモードも共通で呼ばれる。
  async function saveCurrentPrompt(draft: string, mode: SaveMode): Promise<boolean> {
    if (!item.serverId) return false;
    // baseline は比較対象の localPromptDraft と同じ表現(トリム前)で揃える。
    const snapshot: PromptFields = { promptDraft: localPromptDraft };
    setPromptSaveState("saving");
    setPromptSaveError(null);
    try {
      const updated = await saveItemPrompt(item.serverId, draft, mode);
      onItemUpdated(updated);
      setPromptBaseline(snapshot);
      setPromptSaveState("saved");
      return true;
    } catch (e) {
      setPromptSaveError(e instanceof Error ? e.message : "保存に失敗しました");
      setPromptSaveState("error");
      return false;
    }
  }

  // 下書き保存/入力済みにする/保存して次へ、共通の保存フロー。
  // メタデータ保存 → プロンプト保存 → (advance時のみ) 次のアイテムへ、の順で進め、
  // いずれかが失敗したら後続(advance含む)を止める。
  async function saveCurrentItem({ mode, advance }: { mode: SaveMode; advance: boolean }) {
    if (!item.serverId) return;

    const draft = mode === "filled" ? localPromptDraft.trim() : localPromptDraft;
    if (mode === "filled" && !draft) {
      setPromptSaveError("プロンプトを入力してください");
      setPromptSaveState("error");
      return;
    }

    const metaOk = await saveCurrentMetadata();
    if (!metaOk) return;

    const promptOk = await saveCurrentPrompt(draft, mode);
    if (!promptOk) return;

    if (advance) onSelectNext();
  }

  async function handleSaveDraft() {
    await saveCurrentItem({ mode: "draft", advance: false });
  }

  async function handleSaveFilled() {
    await saveCurrentItem({ mode: "filled", advance: false });
  }

  async function handleSaveAndNext() {
    await saveCurrentItem({ mode: "filled", advance: true });
  }

  async function handleSaveMeta() {
    await saveCurrentMetadata();
  }

  // 未保存変更の判定。プロンプト領域・メタデータ領域を別々に比較し、
  // 親へは論理和(いずれかがdirtyならtrue)で通知する。
  const promptDirty = isPromptDirty({ promptDraft: localPromptDraft }, promptBaseline);
  const metaDirty = isMetadataDirty(
    {
      sceneId: localSceneId,
      tagIds: localTagIds,
      personIds: localPersonIds,
      rating: localRating,
      isFavorite: localIsFavorite,
      notes: localNotes,
    },
    metaBaseline,
  );
  const hasUnsavedChanges = promptDirty || metaDirty;
  const isSavingNow = promptSaveState === "saving" || metaSaveState === "saving";

  useEffect(() => {
    onDirtyChange(hasUnsavedChanges);
    // アンマウント時(アイテム切替/Mode切替)は、もうこのフォームの状態を
    // 親が気にする必要がないため false に戻す。
    return () => onDirtyChange(false);
  }, [hasUnsavedChanges, onDirtyChange]);

  useEffect(() => {
    onSavingChange(isSavingNow);
    return () => onSavingChange(false);
  }, [isSavingNow, onSavingChange]);

  // Cmd/Ctrl+Enter からボタンと同じ保存処理を呼べるように公開する。
  // ローカルstateに依存するクロージャを常に最新に保つため、depsを付けず
  // 毎レンダー後に更新する(focusRefの登録パターンを踏襲しつつ、
  // 頻繁に変化するローカル値を参照する必要があるための意図的な違い)。
  useEffect(() => {
    if (!saveAndNextRef) return;
    saveAndNextRef.current = isEditable ? () => { void handleSaveAndNext(); } : null;
    return () => {
      saveAndNextRef.current = null;
    };
  });

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
          <button type="button" onClick={() => void handleSaveDraft()} disabled={!isEditable || promptSaveState === "saving" || metaSaveState === "saving"}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1">
            下書き保存
          </button>
          <button type="button" onClick={() => void handleSaveFilled()} disabled={!isEditable || promptSaveState === "saving" || metaSaveState === "saving"}
            className="rounded-md border border-blue-300 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1">
            入力済みにする
          </button>
          <button type="button" onClick={() => void handleSaveAndNext()} disabled={!isEditable || promptSaveState === "saving" || metaSaveState === "saving"}
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
  onDirtyChange,
  onSavingChange,
  saveAndNextRef,
}: Props) {
  const [mode, setMode] = useState<Mode>("A");
  // ItemForm(Mode A)の現在の未保存/保存中状態をミラーする。
  // Mode Aの切替ボタン自身のガードに使い、かつ親(QuickAddClient)へも転送する。
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  useEffect(() => {
    onSavingChange(isSaving);
  }, [isSaving, onSavingChange]);

  function handleModeChange(next: Mode) {
    if (next === mode) return;
    if (isSaving) return;
    if (next === "B" && isDirty) {
      if (!window.confirm("未保存の変更があります。保存せずに移動しますか？")) return;
    }
    setMode(next);
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Mode tabs */}
      <div role="group" aria-label="入力モード" className="flex shrink-0 items-center gap-2 border-b border-zinc-200 px-4 py-2">
        <button type="button" onClick={() => handleModeChange("A")} aria-pressed={mode === "A"} disabled={isSaving}
          className={["rounded px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 disabled:opacity-50", mode === "A" ? "bg-zinc-900 text-white" : "text-zinc-500 hover:bg-zinc-100"].join(" ")}>
          単体入力 (A)
        </button>
        <button type="button" onClick={() => handleModeChange("B")} aria-pressed={mode === "B"} disabled={isSaving}
          className={["rounded px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 disabled:opacity-50", mode === "B" ? "bg-zinc-900 text-white" : "text-zinc-500 hover:bg-zinc-100"].join(" ")}>
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
              onDirtyChange={setIsDirty} onSavingChange={setIsSaving} saveAndNextRef={saveAndNextRef}
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
