"use client";
import { useState } from "react";

type Option = { id: string; name: string };

type BaseProps = {
  label: string;
  options: Option[];
  onCreate: (name: string) => Promise<Option>;
  disabled?: boolean;
};

type SingleProps = BaseProps & {
  mode: "single";
  value: string | null;
  onChange: (id: string | null) => void;
};

type MultiProps = BaseProps & {
  mode: "multi";
  value: string[];
  onChange: (ids: string[]) => void;
};

type Props = SingleProps | MultiProps;

export default function MasterSelect(props: Props) {
  const { label, options, onCreate, disabled } = props;
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await onCreate(name);
      setNewName("");
      if (props.mode === "single") {
        props.onChange(created.id);
      } else {
        props.onChange([...props.value, created.id]);
      }
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "作成に失敗しました");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-zinc-600">{label}</label>

      {props.mode === "single" ? (
        <select
          value={props.value ?? ""}
          onChange={(e) => props.onChange(e.target.value || null)}
          disabled={disabled}
          className="rounded border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-800 disabled:opacity-50 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
        >
          <option value="">未選択</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </select>
      ) : (
        <div className="max-h-28 overflow-y-auto rounded border border-zinc-200 bg-white p-1">
          {options.length === 0 && (
            <p className="px-1 py-0.5 text-xs text-zinc-400">まだありません</p>
          )}
          {options.map((o) => (
            <label key={o.id} className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-zinc-50">
              <input
                type="checkbox"
                disabled={disabled}
                checked={props.value.includes(o.id)}
                onChange={(e) => {
                  if (e.target.checked) {
                    props.onChange([...props.value, o.id]);
                  } else {
                    props.onChange(props.value.filter((id) => id !== o.id));
                  }
                }}
                className="h-3 w-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1"
              />
              <span className="text-xs text-zinc-700">{o.name}</span>
            </label>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1">
        <input
          type="text"
          placeholder="新規追加…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void handleCreate(); } }}
          disabled={disabled || creating}
          className="flex-1 rounded border border-zinc-200 px-2 py-0.5 text-xs disabled:opacity-50 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
        />
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={disabled || creating || !newName.trim()}
          className="rounded bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700 hover:bg-zinc-200 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1"
        >
          {creating ? "…" : "追加"}
        </button>
      </div>
      {createError && <p className="text-xs text-red-500">{createError}</p>}
    </div>
  );
}
