"use client"

import type { ParseResult } from "@/lib/import/importTypes"

interface ParsePreviewProps {
  result: ParseResult
  onNext: () => void
  onBack: () => void
}

export default function ParsePreview({ result, onNext, onBack }: ParsePreviewProps) {
  return (
    <div className="flex flex-col gap-5">
      {/* File summary */}
      <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3">
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <span className="text-zinc-500">ファイル: <strong className="text-zinc-800">{result.fileName}</strong></span>
          <span className="text-zinc-500">形式: <strong className="text-zinc-800">{result.fileType.toUpperCase()}</strong></span>
          <span className="text-zinc-500">シート: <strong className="text-zinc-800">{result.sheetName}</strong></span>
          <span className="text-zinc-500">データ行数: <strong className="text-zinc-800">{result.rowCount} 行</strong></span>
          <span className="text-zinc-500">列数: <strong className="text-zinc-800">{result.columns.length}</strong></span>
        </div>
      </div>

      {/* Warnings */}
      {result.warnings.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
          {result.warnings.map((w, i) => (
            <p key={i} className="text-sm text-amber-700">⚠ {w}</p>
          ))}
        </div>
      )}

      {/* Detected columns */}
      <div>
        <p className="mb-2 text-sm font-semibold text-zinc-700">検出された列:</p>
        <div className="flex flex-wrap gap-2">
          {result.columns.map((col) => (
            <span key={col} className="rounded-full border border-zinc-200 bg-white px-3 py-0.5 text-xs text-zinc-700">
              {col}
            </span>
          ))}
        </div>
      </div>

      {/* Preview table */}
      <div>
        <p className="mb-2 text-sm font-semibold text-zinc-700">
          プレビュー (先頭 {result.preview.length} 行):
        </p>
        <div className="overflow-x-auto rounded-lg border border-zinc-200">
          <table className="min-w-full text-xs">
            <thead className="bg-zinc-50">
              <tr>
                <th className="border-b border-zinc-200 px-3 py-2 text-left font-semibold text-zinc-500">#</th>
                {result.columns.map((col) => (
                  <th key={col} className="border-b border-zinc-200 px-3 py-2 text-left font-semibold text-zinc-500 max-w-xs">
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 bg-white">
              {result.preview.map((row) => (
                <tr key={row.__rowNumber}>
                  <td className="px-3 py-1.5 text-zinc-400">{row.__rowNumber}</td>
                  {result.columns.map((col) => (
                    <td key={col} className="max-w-xs truncate px-3 py-1.5 text-zinc-700">
                      {row[col] ?? ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-3">
        <button onClick={onBack} className="rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-50">
          ← ファイル選択に戻る
        </button>
        <button onClick={onNext} className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700">
          列マッピングへ →
        </button>
      </div>
    </div>
  )
}
