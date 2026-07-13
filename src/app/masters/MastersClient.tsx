"use client";

import { Suspense, useEffect, useReducer, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { filterTagsForMasters } from "@/lib/masters/tagFilters";

// ---- Types ------------------------------------------------------------------

type Person = { id: string; name: string; notes: string | null; defaultPromptHint: string | null; createdAt: string; imageCount: number };
type Scene = { id: string; name: string; description: string | null; createdAt: string; imageCount: number };
type Tag = { id: string; name: string; createdAt: string; imageCount: number };

type Tab = "persons" | "scenes" | "tags";

// ---- Inline editable row ----------------------------------------------------

function EditableRow({
  label,
  value,
  onSave,
  multiline = false,
}: {
  label: string;
  value: string | null;
  onSave: (v: string | null) => Promise<void>;
  multiline?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft.trim() || null);
      setEditing(false);
    } catch (e: unknown) {
      setError((e as Error).message ?? "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <div className="flex items-start gap-2">
        <span className="text-xs text-zinc-500 w-28 shrink-0 mt-0.5">{label}</span>
        <span className="text-xs text-zinc-800 flex-1 whitespace-pre-wrap break-words">
          {value || <span className="text-zinc-400 italic">未設定</span>}
        </span>
        <button
          onClick={() => { setDraft(value ?? ""); setEditing(true); setError(null); }}
          className="shrink-0 text-xs text-zinc-400 hover:text-zinc-700"
        >
          編集
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <span className="text-xs text-zinc-500 w-28 shrink-0">{label}</span>
        {multiline ? (
          <textarea
            className="flex-1 rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-800 focus:border-blue-400 focus:outline-none"
            rows={3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        ) : (
          <input
            type="text"
            className="flex-1 rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-800 focus:border-blue-400 focus:outline-none"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        )}
      </div>
      {error && <p className="text-xs text-red-500 ml-[7.5rem]">{error}</p>}
      <div className="flex gap-2 ml-[7.5rem]">
        <button
          onClick={() => void handleSave()}
          disabled={saving}
          className="text-xs rounded bg-zinc-800 px-2 py-1 text-white hover:bg-zinc-600 disabled:opacity-50"
        >
          {saving ? "保存中..." : "保存"}
        </button>
        <button
          onClick={() => setEditing(false)}
          disabled={saving}
          className="text-xs text-zinc-400 hover:text-zinc-700"
        >
          キャンセル
        </button>
      </div>
    </div>
  );
}

// ---- DeleteButton -----------------------------------------------------------

function DeleteButton({
  imageCount,
  itemLabel = "マスタ",
  onDelete,
}: {
  imageCount: number;
  /** Phase 10-20A: 文言を分かりやすくするための呼称("タグ"/"人物"/"シーン")。 */
  itemLabel?: string;
  onDelete: () => Promise<void>;
}) {
  const [phase, setPhase] = useState<"idle" | "confirm" | "deleting" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (imageCount > 0) {
    return (
      <p className="text-xs text-zinc-400">
        この{itemLabel}は{imageCount}枚の画像で使用中のため削除できません。統合を使ってください。
      </p>
    );
  }

  if (phase === "idle") {
    return (
      <button
        onClick={() => setPhase("confirm")}
        className="text-xs text-red-500 hover:text-red-700"
      >
        削除
      </button>
    );
  }

  if (phase === "confirm") {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-xs text-red-600">
          この{itemLabel}を削除します。画像には紐づいていない{itemLabel}のみ削除できます。元に戻せません。
        </p>
        <div className="flex gap-2">
          <button
            onClick={async () => {
              setPhase("deleting");
              setErrorMsg(null);
              try {
                await onDelete();
              } catch (e: unknown) {
                setErrorMsg((e as Error).message ?? "削除に失敗しました");
                setPhase("error");
              }
            }}
            className="text-xs rounded bg-red-600 px-2 py-1 text-white hover:bg-red-700"
          >
            削除する
          </button>
          <button
            onClick={() => setPhase("idle")}
            className="text-xs text-zinc-400 hover:text-zinc-700"
          >
            キャンセル
          </button>
        </div>
      </div>
    );
  }

  if (phase === "deleting") {
    return <p className="text-xs text-zinc-400">削除中...</p>;
  }

  return <p className="text-xs text-red-500">{errorMsg ?? "削除に失敗しました"}</p>;
}

// ---- MergePanel -------------------------------------------------------------

type MergePhase = "idle" | "preview" | "previewing" | "ready" | "confirming" | "merging" | "done" | "error";

type MergeCounts = {
  imagesToMove: number;
  duplicatesToSkip: number;
  uploadItemsToMove: number;
  promptGroupsToMove?: number;
  promptVersionsToMove?: number;
};

function MergePanel<T extends { id: string; name: string }>({
  sourceId,
  sourceName,
  allItems,
  mergeEndpoint,
  onMerged,
}: {
  sourceId: string;
  sourceName: string;
  allItems: T[];
  mergeEndpoint: string;
  onMerged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [targetId, setTargetId] = useState("");
  const [phase, setPhase] = useState<MergePhase>("idle");
  const [counts, setCounts] = useState<MergeCounts | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const candidates = allItems.filter((it) => it.id !== sourceId);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-xs text-amber-600 hover:text-amber-800"
      >
        統合...
      </button>
    );
  }

  const doPreview = async () => {
    if (!targetId) return;
    setPhase("previewing");
    setErrorMsg(null);
    try {
      const res = await fetch(mergeEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId, dryRun: true }),
      });
      if (!res.ok) {
        const j = (await res.json()) as { error?: { message?: string } };
        throw new Error(j.error?.message ?? `HTTP ${res.status}`);
      }
      const j = (await res.json()) as { data: { counts: MergeCounts } };
      setCounts(j.data.counts);
      setConfirmed(false);
      setPhase("ready");
    } catch (e: unknown) {
      setErrorMsg((e as Error).message ?? "プレビューに失敗しました");
      setPhase("error");
    }
  };

  const doMerge = async () => {
    setPhase("merging");
    setErrorMsg(null);
    try {
      const res = await fetch(mergeEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId, dryRun: false }),
      });
      if (!res.ok) {
        const j = (await res.json()) as { error?: { message?: string } };
        throw new Error(j.error?.message ?? `HTTP ${res.status}`);
      }
      setPhase("done");
      setTimeout(() => onMerged(), 800);
    } catch (e: unknown) {
      setErrorMsg((e as Error).message ?? "統合に失敗しました");
      setPhase("error");
    }
  };

  return (
    <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-amber-800">統合 ({sourceName})</p>
        <button onClick={() => { setOpen(false); setPhase("idle"); setCounts(null); }} className="text-xs text-zinc-400 hover:text-zinc-700">閉じる</button>
      </div>

      <div className="flex gap-2 items-center">
        <select
          value={targetId}
          onChange={(e) => { setTargetId(e.target.value); setCounts(null); setPhase("idle"); }}
          className="flex-1 rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-800 focus:border-amber-400 focus:outline-none"
          disabled={phase === "previewing" || phase === "merging"}
        >
          <option value="">統合先を選択...</option>
          {candidates.map((it) => (
            <option key={it.id} value={it.id}>{it.name}</option>
          ))}
        </select>
        <button
          onClick={() => void doPreview()}
          disabled={!targetId || phase === "previewing" || phase === "merging"}
          className="text-xs rounded bg-amber-600 px-2 py-1 text-white hover:bg-amber-700 disabled:opacity-50"
        >
          {phase === "previewing" ? "確認中..." : "プレビュー"}
        </button>
      </div>

      {counts && phase === "ready" && (
        <div className="rounded bg-white p-2 text-xs text-zinc-700 space-y-0.5 border border-amber-200">
          <p className="font-semibold text-amber-700">統合プレビュー</p>
          <p>移動する画像: <span className="font-mono">{counts.imagesToMove}</span> 枚</p>
          <p>重複スキップ: <span className="font-mono">{counts.duplicatesToSkip}</span> 枚</p>
          {counts.uploadItemsToMove > 0 && <p>アップロード項目: {counts.uploadItemsToMove}</p>}
          {counts.promptGroupsToMove != null && counts.promptGroupsToMove > 0 && <p>プロンプトグループ: {counts.promptGroupsToMove}</p>}
          {counts.promptVersionsToMove != null && counts.promptVersionsToMove > 0 && <p>プロンプトバージョン: {counts.promptVersionsToMove}</p>}
          <label className="flex items-center gap-1.5 pt-1 cursor-pointer">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span className="text-red-600">統合元マスタは削除されます</span>
          </label>
          <button
            onClick={() => void doMerge()}
            disabled={!confirmed}
            className="mt-1 rounded bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-700 disabled:opacity-50"
          >
            統合する
          </button>
        </div>
      )}

      {phase === "merging" && <p className="text-xs text-zinc-500">統合中...</p>}
      {phase === "done" && <p className="text-xs text-green-600">統合しました ✓</p>}
      {phase === "error" && <p className="text-xs text-red-500">{errorMsg}</p>}
    </div>
  );
}

// ---- Person card ------------------------------------------------------------

function PersonCard({
  person,
  allPersons,
  onUpdated,
  onDeleted,
}: {
  person: Person;
  allPersons: Person[];
  onUpdated: (p: Person) => void;
  onDeleted: (id: string) => void;
}) {
  const patch = async (fields: Partial<Pick<Person, "name" | "notes" | "defaultPromptHint">>) => {
    const res = await fetch(`/api/persons/${person.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    if (!res.ok) {
      const j = (await res.json()) as { error?: { message?: string } };
      throw new Error(j.error?.message ?? `HTTP ${res.status}`);
    }
    const j = (await res.json()) as { data: Omit<Person, "imageCount"> };
    onUpdated({ ...j.data, imageCount: person.imageCount });
  };

  const doDelete = async () => {
    const res = await fetch(`/api/persons/${person.id}`, { method: "DELETE" });
    if (!res.ok) {
      const j = (await res.json()) as { error?: { message?: string } };
      throw new Error(j.error?.message ?? `HTTP ${res.status}`);
    }
    onDeleted(person.id);
  };

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-zinc-900">{person.name}</span>
        <span className="text-xs text-zinc-400">{person.imageCount} 枚</span>
      </div>
      <EditableRow label="名前" value={person.name} onSave={(v) => patch({ name: v ?? person.name })} />
      <EditableRow label="メモ" value={person.notes} onSave={(v) => patch({ notes: v })} multiline />
      <EditableRow label="プロンプトヒント" value={person.defaultPromptHint} onSave={(v) => patch({ defaultPromptHint: v })} multiline />
      <div className="flex items-center gap-3 mt-1 flex-wrap">
        <Link href={`/gallery?personId=${person.id}`} className="text-xs text-blue-600 hover:underline">
          Gallery で絞り込む →
        </Link>
        <DeleteButton imageCount={person.imageCount} itemLabel="人物" onDelete={doDelete} />
      </div>
      <MergePanel
        sourceId={person.id}
        sourceName={person.name}
        allItems={allPersons}
        mergeEndpoint={`/api/persons/${person.id}/merge`}
        onMerged={() => onDeleted(person.id)}
      />
    </div>
  );
}

// ---- Scene card -------------------------------------------------------------

function SceneCard({
  scene,
  allScenes,
  onUpdated,
  onDeleted,
}: {
  scene: Scene;
  allScenes: Scene[];
  onUpdated: (s: Scene) => void;
  onDeleted: (id: string) => void;
}) {
  const patch = async (fields: Partial<Pick<Scene, "name" | "description">>) => {
    const res = await fetch(`/api/scenes/${scene.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    if (!res.ok) {
      const j = (await res.json()) as { error?: { message?: string } };
      throw new Error(j.error?.message ?? `HTTP ${res.status}`);
    }
    const j = (await res.json()) as { data: Omit<Scene, "imageCount"> };
    onUpdated({ ...j.data, imageCount: scene.imageCount });
  };

  const doDelete = async () => {
    const res = await fetch(`/api/scenes/${scene.id}`, { method: "DELETE" });
    if (!res.ok) {
      const j = (await res.json()) as { error?: { message?: string } };
      throw new Error(j.error?.message ?? `HTTP ${res.status}`);
    }
    onDeleted(scene.id);
  };

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-zinc-900">{scene.name}</span>
        <span className="text-xs text-zinc-400">{scene.imageCount} 枚</span>
      </div>
      <EditableRow label="名前" value={scene.name} onSave={(v) => patch({ name: v ?? scene.name })} />
      <EditableRow label="説明" value={scene.description} onSave={(v) => patch({ description: v })} multiline />
      <div className="flex items-center gap-3 mt-1 flex-wrap">
        <Link href={`/gallery?sceneId=${scene.id}`} className="text-xs text-blue-600 hover:underline">
          Gallery で絞り込む →
        </Link>
        <DeleteButton imageCount={scene.imageCount} itemLabel="シーン" onDelete={doDelete} />
      </div>
      <MergePanel
        sourceId={scene.id}
        sourceName={scene.name}
        allItems={allScenes}
        mergeEndpoint={`/api/scenes/${scene.id}/merge`}
        onMerged={() => onDeleted(scene.id)}
      />
    </div>
  );
}

// ---- AddTagForm (Phase 10-20A) ----------------------------------------------
//
// タグ本体(Tag master)を新規作成するフォーム。既存 POST /api/tags をそのまま
// 利用する — 新規APIは追加しない。POST /api/tags は名前がworkspace内で既存と
// 衝突する場合、新規作成せず既存Tagを200で返す仕様(重複作成しない)。

type AddTagPhase = "idle" | "adding" | "error";

function AddTagForm({ onAdded }: { onAdded: (tag: Tag) => void }) {
  const [draft, setDraft] = useState("");
  const [phase, setPhase] = useState<AddTagPhase>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const submit = async () => {
    if (draft.trim() === "") return;
    setPhase("adding");
    setErrorMsg(null);
    try {
      const res = await fetch("/api/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: draft }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(j.error?.message ?? "タグの追加に失敗しました");
      }
      const j = (await res.json()) as { data: Omit<Tag, "imageCount"> };
      onAdded({ ...j.data, imageCount: 0 });
      setDraft("");
      setPhase("idle");
    } catch (e: unknown) {
      setErrorMsg((e as Error).message ?? "タグの追加に失敗しました");
      setPhase("error");
    }
  };

  const isAdding = phase === "adding";

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-zinc-200 bg-white p-3">
      <div className="flex flex-wrap gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
          disabled={isAdding}
          placeholder="タグ名を入力"
          className="min-w-0 flex-1 rounded-md border border-zinc-300 px-2.5 py-1.5 text-sm focus:border-blue-400 focus:outline-none disabled:opacity-50"
        />
        <button
          onClick={() => void submit()}
          disabled={isAdding || draft.trim() === ""}
          className="rounded-md bg-zinc-800 px-3 py-1.5 text-sm text-white hover:bg-zinc-700 disabled:opacity-50"
        >
          {isAdding ? "追加中..." : "タグを追加"}
        </button>
      </div>
      {phase === "error" && errorMsg && <p className="text-xs text-red-500">{errorMsg}</p>}
    </div>
  );
}

// ---- Tag card ---------------------------------------------------------------

function TagCard({
  tag,
  allTags,
  onUpdated,
  onDeleted,
}: {
  tag: Tag;
  allTags: Tag[];
  onUpdated: (t: Tag) => void;
  onDeleted: (id: string) => void;
}) {
  const patch = async (name: string) => {
    const res = await fetch(`/api/tags/${tag.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const j = (await res.json()) as { error?: { message?: string } };
      throw new Error(j.error?.message ?? `HTTP ${res.status}`);
    }
    const j = (await res.json()) as { data: Omit<Tag, "imageCount"> };
    onUpdated({ ...j.data, imageCount: tag.imageCount });
  };

  const doDelete = async () => {
    const res = await fetch(`/api/tags/${tag.id}`, { method: "DELETE" });
    if (!res.ok) {
      const j = (await res.json()) as { error?: { message?: string } };
      throw new Error(j.error?.message ?? `HTTP ${res.status}`);
    }
    onDeleted(tag.id);
  };

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-zinc-900">{tag.name}</span>
        <span className="text-xs text-zinc-400">{tag.imageCount} 枚</span>
      </div>
      <EditableRow label="名前" value={tag.name} onSave={(v) => patch(v ?? tag.name)} />
      <div className="flex items-center gap-3 mt-1 flex-wrap">
        <Link href={`/gallery?tagId=${tag.id}`} className="text-xs text-blue-600 hover:underline">
          Gallery で絞り込む →
        </Link>
        <DeleteButton imageCount={tag.imageCount} itemLabel="タグ" onDelete={doDelete} />
      </div>
      <MergePanel
        sourceId={tag.id}
        sourceName={tag.name}
        allItems={allTags}
        mergeEndpoint={`/api/tags/${tag.id}/merge`}
        onMerged={() => onDeleted(tag.id)}
      />
    </div>
  );
}

// ---- List states ------------------------------------------------------------

type ListState<T> =
  | { phase: "loading" }
  | { phase: "ok"; items: T[] }
  | { phase: "error"; message: string };

function useList<T extends { id: string }>(url: string) {
  type Action =
    | { type: "load" }
    | { type: "ok"; items: T[] }
    | { type: "error"; message: string }
    | { type: "update"; item: T }
    | { type: "remove"; id: string }
    | { type: "add"; item: T };

  const [state, dispatch] = useReducer(
    (s: ListState<T>, a: Action): ListState<T> => {
      if (a.type === "load") return { phase: "loading" };
      if (a.type === "ok") return { phase: "ok", items: a.items };
      if (a.type === "error") return { phase: "error", message: a.message };
      if (a.type === "update" && s.phase === "ok") {
        return {
          phase: "ok",
          items: s.items.map((it) => (it.id === a.item.id ? a.item : it)),
        };
      }
      if (a.type === "remove" && s.phase === "ok") {
        return { phase: "ok", items: s.items.filter((it) => it.id !== a.id) };
      }
      if (a.type === "add" && s.phase === "ok") {
        // POST /api/tags は名前が既存と衝突した場合、新規作成せず既存行を
        // 200で返す仕様。ただしそのレスポンスにはimageCountが含まれないため、
        // 既にidが一覧にある場合は絶対に置換しない(useListはgenericで
        // imageCount前提にできないため、「既存idなら何もしない」を安全側の
        // 方針とする — 置換すると呼び出し元が渡した不完全なitemで
        // imageCount等の既存フィールドを壊してしまう)。新規idの場合のみ
        // 先頭に追加する(名前順への再ソートはせず、次回GETまでの見た目のみ)。
        const exists = s.items.some((it) => it.id === a.item.id);
        return {
          phase: "ok",
          items: exists ? s.items : [a.item, ...s.items],
        };
      }
      return s;
    },
    { phase: "loading" },
  );

  useEffect(() => {
    let cancelled = false;
    dispatch({ type: "load" });
    fetch(url)
      .then((r) => r.json())
      .then((j: { data?: T[] }) => {
        if (!cancelled) dispatch({ type: "ok", items: j.data ?? [] });
      })
      .catch((e: unknown) => {
        if (!cancelled) dispatch({ type: "error", message: (e as Error).message ?? "エラー" });
      });
    return () => { cancelled = true; };
  }, [url]);

  const update = (item: T) => dispatch({ type: "update", item });
  const remove = (id: string) => dispatch({ type: "remove", id });
  const add = (item: T) => dispatch({ type: "add", item });

  return { state, update, remove, add };
}

// ---- Main -------------------------------------------------------------------

const VALID_TABS: Tab[] = ["persons", "scenes", "tags"];

function isValidTab(value: string | null): value is Tab {
  return value !== null && (VALID_TABS as string[]).includes(value);
}

function MastersInner() {
  const searchParams = useSearchParams();
  // Phase 10-20A: ?tab=tags のようなdeep linkでタブを指定できるようにする
  // (Gallery側の「タグを管理」導線用)。不正/未指定なら従来通り"persons"。
  const initialTab = isValidTab(searchParams.get("tab")) ? (searchParams.get("tab") as Tab) : "persons";
  const [tab, setTab] = useState<Tab>(initialTab);
  const [q, setQ] = useState("");
  // Phase 10-17B: Tagsタブ限定の表示フィルタ（クライアント側のみ、非破壊的）。
  const [tagsUnusedOnly, setTagsUnusedOnly] = useState(false);

  const personUrl = `/api/persons${q ? `?q=${encodeURIComponent(q)}` : ""}`;
  const sceneUrl = `/api/scenes${q ? `?q=${encodeURIComponent(q)}` : ""}`;
  const tagUrl = `/api/tags${q ? `?q=${encodeURIComponent(q)}` : ""}`;

  const persons = useList<Person>(personUrl);
  const scenes = useList<Scene>(sceneUrl);
  const tags = useList<Tag>(tagUrl);

  const tabs: { id: Tab; label: string }[] = [
    { id: "persons", label: "人物" },
    { id: "scenes", label: "シーン" },
    { id: "tags", label: "タグ" },
  ];

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-50">
      {/* Header */}
      <header className="flex items-center gap-4 border-b border-zinc-200 bg-white px-5 py-3">
        <Link href="/gallery" className="text-sm text-zinc-500 hover:text-zinc-900">Gallery</Link>
        <Link href="/quick-add" className="text-sm text-zinc-500 hover:text-zinc-900">Quick Add</Link>
        <Link href="/import" className="text-sm text-zinc-500 hover:text-zinc-900">Import</Link>
        <h1 className="text-base font-semibold text-zinc-900">Masters</h1>
        <div className="ml-auto w-56">
          <input
            type="text"
            placeholder="名前で絞り込み..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-blue-400 focus:outline-none"
          />
        </div>
      </header>

      {/* Tabs */}
      <div className="flex gap-0 border-b border-zinc-200 bg-white px-5">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 text-sm font-medium transition-colors ${
              tab === t.id
                ? "border-b-2 border-blue-500 text-blue-600"
                : "text-zinc-500 hover:text-zinc-800"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-5">
        {tab === "persons" && (
          <ListPanel state={persons.state}>
            {(items: Person[]) =>
              items.map((p) => (
                <PersonCard
                  key={p.id}
                  person={p}
                  allPersons={persons.state.phase === "ok" ? persons.state.items : []}
                  onUpdated={(updated) => persons.update(updated)}
                  onDeleted={(id) => persons.remove(id)}
                />
              ))
            }
          </ListPanel>
        )}
        {tab === "scenes" && (
          <ListPanel state={scenes.state}>
            {(items: Scene[]) =>
              items.map((s) => (
                <SceneCard
                  key={s.id}
                  scene={s}
                  allScenes={scenes.state.phase === "ok" ? scenes.state.items : []}
                  onUpdated={(updated) => scenes.update(updated)}
                  onDeleted={(id) => scenes.remove(id)}
                />
              ))
            }
          </ListPanel>
        )}
        {tab === "tags" && (
          <div className="flex flex-col gap-3">
            <AddTagForm onAdded={(tag) => tags.add(tag)} />
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex cursor-pointer items-center gap-1.5 text-sm text-zinc-700">
                <input
                  type="checkbox"
                  checked={tagsUnusedOnly}
                  onChange={(e) => setTagsUnusedOnly(e.target.checked)}
                />
                使用数0件のみ
              </label>
              {tags.state.phase === "ok" && (
                <span className="text-xs text-zinc-400">
                  表示中: {filterTagsForMasters(tags.state.items, { unusedOnly: tagsUnusedOnly }).length}件 / 全体: {tags.state.items.length}件
                </span>
              )}
            </div>
            <ListPanel state={tags.state}>
              {(items: Tag[]) => {
                const filtered = filterTagsForMasters(items, { unusedOnly: tagsUnusedOnly });
                if (filtered.length === 0 && tagsUnusedOnly) {
                  return <div className="col-span-full text-sm text-zinc-400">使用数0件のタグはありません</div>;
                }
                return filtered.map((t) => (
                  <TagCard
                    key={t.id}
                    tag={t}
                    allTags={tags.state.phase === "ok" ? tags.state.items : []}
                    onUpdated={(updated) => tags.update(updated)}
                    onDeleted={(id) => tags.remove(id)}
                  />
                ));
              }}
            </ListPanel>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Public export with Suspense boundary (useSearchParams requires it) ----

export default function MastersClient() {
  return (
    <Suspense fallback={null}>
      <MastersInner />
    </Suspense>
  );
}

function ListPanel<T>({
  state,
  children,
}: {
  state: ListState<T>;
  children: (items: T[]) => React.ReactNode;
}) {
  if (state.phase === "loading") {
    return <div className="text-sm text-zinc-400">読み込み中...</div>;
  }
  if (state.phase === "error") {
    return <div className="text-sm text-red-500">{state.message}</div>;
  }
  if (state.items.length === 0) {
    return <div className="text-sm text-zinc-400">データがありません</div>;
  }
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {children(state.items)}
    </div>
  );
}
