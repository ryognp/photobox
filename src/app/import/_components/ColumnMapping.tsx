"use client"

import type { ColumnMapping, ParseResult } from "@/lib/import/importTypes"

interface ColumnMappingProps {
  result: ParseResult
  mapping: ColumnMapping
  onChange: (patch: Partial<ColumnMapping>) => void
  onBack: () => void
}

type MappingField = {
  key: keyof ColumnMapping
  label: string
  required: boolean
}

const FIELDS: MappingField[] = [
  { key: "imageUrlColumn", label: "画像URL (image_url)", required: true },
  { key: "promptColumn",   label: "プロンプト (prompt)",  required: false },
  { key: "personColumn",   label: "人物 (person)",        required: false },
  { key: "sceneColumn",    label: "シーン (scene)",        required: false },
  { key: "tagsColumn",     label: "タグ (tags)",           required: false },
  { key: "ratingColumn",   label: "評価 (rating)",        required: false },
  { key: "notesColumn",    label: "メモ (notes)",         required: false },
]

export default function ColumnMapping({ result, mapping, onChange, onBack }: ColumnMappingProps) {
  const canProceed = mapping.imageUrlColumn !== null

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-md border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-700">
        ファイルの列と Photobox のフィールドを対応付けてください。<br />
        <strong>「画像URL」のみ必須</strong>です。その他は任意です。
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 bg-zinc-50">
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-zinc-500">Photobox フィールド</th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-zinc-500">ファイルの列</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {FIELDS.map(({ key, label, required }) => (
              <tr key={key}>
                <td className="px-4 py-2.5">
                  <span className="text-zinc-800">{label}</span>
                  {required && <span className="ml-1 text-red-500">*</span>}
                </td>
                <td className="px-4 py-2.5">
                  <select
                    value={mapping[key] ?? ""}
                    onChange={(e) => onChange({ [key]: e.target.value || null })}
                    className={`rounded-md border px-2 py-1 text-sm text-zinc-800 outline-none focus:ring-1 focus:ring-blue-500 ${
                      required && !mapping[key]
                        ? "border-red-300 focus:border-red-400"
                        : "border-zinc-300 focus:border-blue-400"
                    }`}
                  >
                    <option value="">— 対応なし —</option>
                    {result.columns.map((col) => (
                      <option key={col} value={col}>{col}</option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!canProceed && (
        <p className="text-sm text-red-600">「画像URL」列の指定が必須です</p>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-50">
          ← 解析結果に戻る
        </button>

        <div className="flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-4 py-2">
          <span className="text-sm text-zinc-400">Import プレビュー・実行</span>
          <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs text-zinc-500">Day 7-B-2 で実装予定</span>
        </div>

        {/* disabled ボタン — Day 7-B-2 で active になる */}
        <button
          disabled={!canProceed}
          className="cursor-not-allowed rounded-md bg-blue-600 px-4 py-2 text-sm text-white opacity-40"
          title="Day 7-B-2 で実装予定"
        >
          Import プレビューへ →
        </button>
      </div>
    </div>
  )
}
