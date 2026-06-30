"use client";

import MasterSelect from "./MasterSelect";
import RatingInput from "./RatingInput";
import type { Scene, Tag, Person } from "@/lib/quick-add/masterClient";

type Props = {
  sceneId: string | null;
  tagIds: string[];
  personIds: string[];
  rating: number | null;
  isFavorite: boolean;
  notes: string;
  scenes: Scene[];
  tags: Tag[];
  persons: Person[];
  onSceneChange: (id: string | null) => void;
  onTagsChange: (ids: string[]) => void;
  onPersonsChange: (ids: string[]) => void;
  onRatingChange: (v: number | null) => void;
  onFavoriteChange: (v: boolean) => void;
  onNotesChange: (v: string) => void;
  onSceneCreated: (s: Scene) => void;
  onTagCreated: (t: Tag) => void;
  onPersonCreated: (p: Person) => void;
  createScene: (name: string) => Promise<{ id: string; name: string }>;
  createTag: (name: string) => Promise<{ id: string; name: string }>;
  createPerson: (name: string) => Promise<{ id: string; name: string }>;
  disabled?: boolean;
};

export default function MetaForm({
  sceneId,
  tagIds,
  personIds,
  rating,
  isFavorite,
  notes,
  scenes,
  tags,
  persons,
  onSceneChange,
  onTagsChange,
  onPersonsChange,
  onRatingChange,
  onFavoriteChange,
  onNotesChange,
  onSceneCreated,
  onTagCreated,
  onPersonCreated,
  createScene,
  createTag,
  createPerson,
  disabled = false,
}: Props) {
  return (
    <div className="flex flex-col gap-4 overflow-y-auto">
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-gray-700">シーン</label>
        <MasterSelect
          mode="single"
          label="シーン"
          options={scenes}
          value={sceneId}
          onChange={onSceneChange}
          onCreate={async (name) => {
            const created = await createScene(name);
            onSceneCreated(created as Scene);
            return created;
          }}
          disabled={disabled}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-gray-700">タグ</label>
        <MasterSelect
          mode="multi"
          label="タグ"
          options={tags}
          value={tagIds}
          onChange={onTagsChange}
          onCreate={async (name) => {
            const created = await createTag(name);
            onTagCreated(created as Tag);
            return created;
          }}
          disabled={disabled}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-gray-700">人物</label>
        <MasterSelect
          mode="multi"
          label="人物"
          options={persons}
          value={personIds}
          onChange={onPersonsChange}
          onCreate={async (name) => {
            const created = await createPerson(name);
            onPersonCreated(created as Person);
            return created;
          }}
          disabled={disabled}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-gray-700">評価</label>
        <RatingInput value={rating} onChange={onRatingChange} disabled={disabled} />
      </div>

      <div className="flex items-center gap-2">
        <input
          id="isFavorite"
          type="checkbox"
          checked={isFavorite}
          onChange={(e) => onFavoriteChange(e.target.checked)}
          disabled={disabled}
          className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
        />
        <label htmlFor="isFavorite" className="text-sm font-medium text-gray-700 select-none cursor-pointer">
          お気に入り
        </label>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-gray-700">メモ</label>
        <textarea
          value={notes}
          onChange={(e) => onNotesChange(e.target.value)}
          disabled={disabled}
          rows={3}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-50 disabled:opacity-50 resize-none"
        />
      </div>
    </div>
  );
}
