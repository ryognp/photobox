"use client"

import { useRef, useReducer } from "react"

interface FileDropzoneProps {
  onFile: (file: File) => void
  loading: boolean
  error: string | null
}

const MAX_MB = 4;
const MAX_BYTES = MAX_MB * 1024 * 1024;

export default function FileDropzone({ onFile, loading, error }: FileDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useReducer((_: boolean, v: boolean) => v, false)
  const [localError, setLocalError] = useReducer((_: string | null, v: string | null) => v, null)

  const handleFile = (file: File) => {
    setLocalError(null)
    const ext = file.name.split(".").pop()?.toLowerCase()
    if (ext !== "csv" && ext !== "xlsx") {
      setLocalError("CSV (.csv) または XLSX (.xlsx) ファイルのみ対応しています")
      return
    }
    if (file.size > MAX_BYTES) {
      setLocalError(`ファイルサイズが ${MAX_MB}MB を超えています (${(file.size / 1024 / 1024).toFixed(1)} MB)`)
      return
    }
    onFile(file)
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
    e.target.value = ""
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  const displayError = localError ?? error

  return (
    <div className="flex flex-col gap-4">
      {/* Google Drive 注意 */}
      <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
        <strong>注意:</strong> Google Drive 共有リンクは非対応です。直接 fetch 可能な HTTPS 画像 URL を使用してください。
      </div>

      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-12 transition-colors ${
          dragging ? "border-blue-400 bg-blue-50" : "border-zinc-300 bg-white hover:border-zinc-400 hover:bg-zinc-50"
        }`}
      >
        <svg className="h-10 w-10 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
        </svg>
        <div className="text-center">
          <p className="text-sm font-medium text-zinc-700">CSV / XLSX をドラッグ&amp;ドロップ</p>
          <p className="mt-1 text-xs text-zinc-400">または クリックして選択 · 最大 {MAX_MB}MB</p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.xlsx"
          onChange={handleInputChange}
          className="hidden"
        />
      </div>

      {displayError && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
          {displayError}
        </p>
      )}

      {loading && (
        <p className="text-center text-sm text-zinc-500">解析中...</p>
      )}
    </div>
  )
}
