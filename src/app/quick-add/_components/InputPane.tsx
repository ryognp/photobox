"use client";

import { useState, useEffect, useLayoutEffect, useRef, useId, useCallback } from "react";
import type { LocalItem } from "../types";
import type { Scene, Tag, Person } from "@/lib/quick-add/masterClient";
import { saveItemPrompt, updateItemMetadata } from "@/lib/quick-add/itemClient";
import type { SaveMode } from "@/lib/quick-add/itemClient";
import {
  isPromptDirty,
  isMetadataDirty,
  canonicalizePrompt,
  canonicalizeMetadata,
  canAdvanceAfterSave,
  derivePromptStatus,
  parsePromptStatus,
  type PromptFields,
  type MetadataFields,
  type PromptStatusValue,
} from "@/lib/quick-add/itemDirty";
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
  // 「ユーザーが最後に要求した保存status」(intent)。初期値はサーバー保存値。
  // 保存操作開始時に derivePromptStatus の結果へ更新し、失敗しても要求値のまま残す
  // (本文が同じでも DRAFT→FILLED 等の未完了の保存意図を dirty として検知するため)。
  const [localPromptStatus, setLocalPromptStatus] = useState<PromptStatusValue>(() =>
    parsePromptStatus(si?.promptStatus)
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
  // baseline は常に canonical 値(サーバーが保存する意味上の値)で保持し、
  // 保存成功時のみ「リクエスト開始時に実際へ送信した snapshot」で更新する
  // (通信完了時点の最新UI値ではない — 通信中の追加変更を dirty として残すため)。
  // render中に参照するため ref ではなく state で保持する(refをrender中に読むこと自体が禁止のため)。
  const [promptBaseline, setPromptBaseline] = useState<PromptFields>(() =>
    canonicalizePrompt({
      promptDraft: (si?.promptDraft as string | null) ?? "",
      promptStatus: parsePromptStatus(si?.promptStatus),
    })
  );
  const [metaBaseline, setMetaBaseline] = useState<MetadataFields>(() =>
    canonicalizeMetadata({
      sceneId: (si?.sceneId as string | null) ?? null,
      tagIds: (si?.tags as Array<{ tag: { id: string } }> | undefined)?.map((t) => t.tag.id) ?? [],
      personIds: (si?.persons as Array<{ person: { id: string } }> | undefined)?.map((p) => p.person.id) ?? [],
      rating: (si?.rating as number | null) ?? null,
      isFavorite: (si?.isFavorite as boolean) ?? false,
      notes: (si?.notes as string | null) ?? "",
    })
  );

  // 最新UI値の同期ミラー。入力変更は必ず下の update* ラッパー経由で行い、
  // state と同時にこの ref も更新する。async な保存処理の完了時点で
  // 「保存開始時の closure が持つ古い state」ではなく最新UI値を確実に読むために使う。
  const latestFieldsRef = useRef<{ prompt: PromptFields; meta: MetadataFields }>({
    prompt: {
      promptDraft: (si?.promptDraft as string | null) ?? "",
      promptStatus: parsePromptStatus(si?.promptStatus),
    },
    meta: {
      sceneId: (si?.sceneId as string | null) ?? null,
      tagIds: (si?.tags as Array<{ tag: { id: string } }> | undefined)?.map((t) => t.tag.id) ?? [],
      personIds: (si?.persons as Array<{ person: { id: string } }> | undefined)?.map((p) => p.person.id) ?? [],
      rating: (si?.rating as number | null) ?? null,
      isFavorite: (si?.isFavorite as boolean) ?? false,
      notes: (si?.notes as string | null) ?? "",
    },
  });

  function updateMetaFields(patch: Partial<MetadataFields>) {
    latestFieldsRef.current = {
      ...latestFieldsRef.current,
      meta: { ...latestFieldsRef.current.meta, ...patch },
    };
  }
  function updatePromptDraft(v: string) {
    latestFieldsRef.current = {
      ...latestFieldsRef.current,
      prompt: { ...latestFieldsRef.current.prompt, promptDraft: v },
    };
    setLocalPromptDraft(v);
  }
  // 保存操作開始時に「今回要求するstatus」を現在値へ反映する(ref/state同時・同期)。
  function updatePromptStatusIntent(status: PromptStatusValue) {
    latestFieldsRef.current = {
      ...latestFieldsRef.current,
      prompt: { ...latestFieldsRef.current.prompt, promptStatus: status },
    };
    setLocalPromptStatus(status);
  }
  function updateSceneId(v: string | null) { updateMetaFields({ sceneId: v }); setLocalSceneId(v); }
  function updateTagIds(ids: string[]) { updateMetaFields({ tagIds: ids }); setLocalTagIds(ids); }
  function updatePersonIds(ids: string[]) { updateMetaFields({ personIds: ids }); setLocalPersonIds(ids); }
  function updateRating(v: number | null) { updateMetaFields({ rating: v }); setLocalRating(v); }
  function updateIsFavorite(v: boolean) { updateMetaFields({ isFavorite: v }); setLocalIsFavorite(v); }
  function updateNotes(v: string) { updateMetaFields({ notes: v }); setLocalNotes(v); }

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

  // 保存操作全体(entry point)の同期的な排他ロック。state の disabled 表示は
  // 表示用でしかないため、正本はこの ref。最初の await より前に取得し、
  // finally で必ず解放する。ロック中の再入(連続クリック/連続ショートカット/
  // 別の保存ボタン)は no-op。isSavingOp は同じ区間の表示用ミラー。
  const saveLockRef = useRef(false);
  const [isSavingOp, setIsSavingOp] = useState(false);

  async function withSaveLock(fn: () => Promise<void>): Promise<void> {
    if (saveLockRef.current) return;
    saveLockRef.current = true;
    setIsSavingOp(true);
    // 親(InputPane → QuickAddClient)へは effect を挟まず、この場で同期通知する
    onSavingChange(true);
    try {
      await fn();
    } finally {
      saveLockRef.current = false;
      setIsSavingOp(false);
      onSavingChange(false);
    }
  }

  // snapshot(canonical化・配列コピー済み)をAPIへ送り、成功時はその snapshot を
  // baseline にする。送信値と baseline 更新値は同じ snapshot から作る。
  async function saveMetadataSnapshot(snapshot: MetadataFields): Promise<boolean> {
    if (!item.serverId) return false;
    setMetaSaveState("saving");
    setMetaSaveError(null);
    try {
      const updated = await updateItemMetadata(item.serverId, {
        sceneId: snapshot.sceneId,
        tagIds: snapshot.tagIds,
        personIds: snapshot.personIds,
        rating: snapshot.rating,
        isFavorite: snapshot.isFavorite,
        notes: snapshot.notes || null, // canonical(trim済み)なので "" → null
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

  async function savePromptSnapshot(snapshot: PromptFields, mode: SaveMode): Promise<boolean> {
    if (!item.serverId) return false;
    setPromptSaveState("saving");
    setPromptSaveError(null);
    try {
      const updated = await saveItemPrompt(item.serverId, snapshot.promptDraft, mode);
      onItemUpdated(updated);
      // baseline の status は API レスポンスの promptStatus を正本とする。
      // 欠落時はサーバーと同じ規則で導出済みの snapshot 側の値へフォールバック。
      setPromptBaseline({
        promptDraft: snapshot.promptDraft,
        promptStatus: parsePromptStatus(updated.promptStatus, snapshot.promptStatus),
      });
      setPromptSaveState("saved");
      return true;
    } catch (e) {
      // 失敗時: baseline は更新しない。status intent も要求値のまま残る
      // (本文が同じでも intent ≠ baseline なら dirty が維持される)。
      setPromptSaveError(e instanceof Error ? e.message : "保存に失敗しました");
      setPromptSaveState("error");
      return false;
    }
  }

  // 下書き保存/入力済みにする/保存して次へ、共通の保存フロー。
  // 保存操作開始時点で両領域の snapshot を取り、APIへはその値だけを送る。
  // メタデータ保存 → プロンプト保存 → (advance時のみ) 次のアイテムへ、の順で進め、
  // いずれかが失敗したら後続(advance含む)を止める。
  // advance は、両API成功後に「最新UI値(latestFieldsRef)」と「今回保存した snapshot」を
  // 比較し、保存中に有効な変更が加えられていない場合のみ行う(保存中の追加編集を
  // remount で破棄しないため)。
  async function saveCurrentItem({ mode, advance }: { mode: SaveMode; advance: boolean }) {
    if (!item.serverId || saveLockRef.current) return;

    const draftCanonical = latestFieldsRef.current.prompt.promptDraft.trim();
    const metaSnapshot = canonicalizeMetadata(latestFieldsRef.current.meta);

    // filled の空文字 validation を通過した後にのみ FILLED intent を設定する
    if (mode === "filled" && !draftCanonical) {
      setPromptSaveError("プロンプトを入力してください");
      setPromptSaveState("error");
      return;
    }

    // 今回の保存が要求する promptStatus(サーバーの normalizePromptStatus と同規則)
    const requestedStatus = derivePromptStatus(draftCanonical, mode);
    const promptSnapshot: PromptFields = {
      promptDraft: draftCanonical,
      promptStatus: requestedStatus,
    };

    await withSaveLock(async () => {
      // ロック取得後・最初の await より前に、要求 status を現在値(ref/state)へ同期反映。
      // 保存が失敗しても intent は残り、baseline と異なれば dirty が維持される。
      updatePromptStatusIntent(requestedStatus);

      const metaOk = await saveMetadataSnapshot(metaSnapshot);
      if (!metaOk) return;

      const promptOk = await savePromptSnapshot(promptSnapshot, mode);
      if (!promptOk) return;

      if (!advance) return;
      const ok = canAdvanceAfterSave({
        currentPrompt: latestFieldsRef.current.prompt,
        savedPrompt: promptSnapshot,
        currentMetadata: latestFieldsRef.current.meta,
        savedMetadata: metaSnapshot,
      });
      if (ok) onSelectNext();
      // ok でない場合は現在の画像に留まる。追加変更は dirty として残り、
      // baseline は snapshot のままなので遷移ガードが機能する。
    });
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
    if (!item.serverId || saveLockRef.current) return;
    const metaSnapshot = canonicalizeMetadata(latestFieldsRef.current.meta);
    await withSaveLock(async () => {
      await saveMetadataSnapshot(metaSnapshot);
    });
  }

  // 未保存変更の判定。プロンプト領域・メタデータ領域を別々に比較し、
  // 親へは論理和(いずれかがdirtyならtrue)で通知する。
  const promptDirty = isPromptDirty(
    { promptDraft: localPromptDraft, promptStatus: localPromptStatus },
    promptBaseline,
  );
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

  useEffect(() => {
    onDirtyChange(hasUnsavedChanges);
    // アンマウント時(アイテム切替/Mode切替)は、もうこのフォームの状態を
    // 親が気にする必要がないため false に戻す。
    return () => onDirtyChange(false);
  }, [hasUnsavedChanges, onDirtyChange]);

  // saving の親への通知は withSaveLock 内で同期的に行う(effectを挟まない)。
  // ここでは保存中にunmountされた場合の後始末だけを行う。
  useEffect(() => {
    return () => onSavingChange(false);
  }, [onSavingChange]);

  // Cmd/Ctrl+Enter からボタンと同じ保存処理を呼べるように公開する。
  // useLayoutEffect(deps なし)で毎レンダーcommit と同期して登録し直すことで、
  // 古い closure が残る隙間をなくす。アイテム切替(key変更による remount)時は
  // 旧フォームの cleanup が新フォームの登録より前に同期実行されるため、
  // 切替直後のショートカットが前アイテムの handler を呼ぶことはない。
  // 編集不可時は null(ショートカット側で no-op)。unmount/Mode B 切替時も null に戻る。
  useLayoutEffect(() => {
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
          onChange={(e) => { updatePromptDraft(e.target.value); setPromptSaveError(null); }}
          disabled={!isEditable}
          placeholder={!isDone ? "アップロード完了後に入力できます" : isCommitted ? "コミット済みのため編集できません" : "プロンプトを入力…"}
          className="resize-none rounded-md border border-zinc-200 px-3 py-2 text-xs text-zinc-800 placeholder-zinc-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-50"
        />
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void handleSaveDraft()} disabled={!isEditable || isSavingOp}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1">
            下書き保存
          </button>
          <button type="button" onClick={() => void handleSaveFilled()} disabled={!isEditable || isSavingOp}
            className="rounded-md border border-blue-300 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1">
            入力済みにする
          </button>
          <button type="button" onClick={() => void handleSaveAndNext()} disabled={!isEditable || isSavingOp}
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
          onSceneChange={updateSceneId} onTagsChange={updateTagIds} onPersonsChange={updatePersonIds}
          onRatingChange={updateRating} onFavoriteChange={updateIsFavorite} onNotesChange={updateNotes}
          onSceneCreated={onSceneCreated} onTagCreated={onTagCreated} onPersonCreated={onPersonCreated}
          createScene={createScene} createTag={createTag} createPerson={createPerson}
        />
        <button type="button" onClick={() => void handleSaveMeta()} disabled={!isEditable || isSavingOp}
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
  // 転送は useEffect を挟まず、ItemForm からの通知と同一の同期 callback 内で行う
  // (保存ロック開始と同じタイミングで QuickAddClient 側の ref まで更新されるようにする)。
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const handleItemDirtyChange = useCallback((dirty: boolean) => {
    setIsDirty(dirty);
    onDirtyChange(dirty);
  }, [onDirtyChange]);

  const handleItemSavingChange = useCallback((saving: boolean) => {
    setIsSaving(saving);
    onSavingChange(saving);
  }, [onSavingChange]);

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
              onDirtyChange={handleItemDirtyChange} onSavingChange={handleItemSavingChange} saveAndNextRef={saveAndNextRef}
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
