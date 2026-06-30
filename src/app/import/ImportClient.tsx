"use client"

import { useReducer } from "react"
import { useRouter } from "next/navigation"
import type { ParseResult, ColumnMapping, ImportStep } from "@/lib/import/importTypes"
import FileDropzone from "./_components/FileDropzone"
import ParsePreview from "./_components/ParsePreview"
import ColumnMapping_ from "./_components/ColumnMapping"

type State = {
  step: ImportStep
  file: File | null
  parseResult: ParseResult | null
  mapping: ColumnMapping
  loading: boolean
  error: string | null
}

type Action =
  | { type: "file_selected"; file: File }
  | { type: "parse_start" }
  | { type: "parse_ok"; result: ParseResult }
  | { type: "parse_error"; message: string }
  | { type: "go_mapping" }
  | { type: "go_preview" }
  | { type: "go_back_upload" }
  | { type: "go_back_parse" }
  | { type: "patch_mapping"; patch: Partial<ColumnMapping> }

const EMPTY_MAPPING: ColumnMapping = {
  imageUrlColumn: null,
  promptColumn: null,
  personColumn: null,
  sceneColumn: null,
  tagsColumn: null,
  ratingColumn: null,
  notesColumn: null,
}

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "file_selected":
      return { ...s, file: a.file, error: null }
    case "parse_start":
      return { ...s, loading: true, error: null }
    case "parse_ok":
      return { ...s, loading: false, parseResult: a.result, mapping: a.result.autoMapping, step: "preview" }
    case "parse_error":
      return { ...s, loading: false, error: a.message }
    case "go_mapping":
      return { ...s, step: "mapping" }
    case "go_back_upload":
      return { ...s, step: "upload", file: null, parseResult: null, error: null }
    case "go_back_parse":
      return { ...s, step: "preview" }
    case "patch_mapping":
      return { ...s, mapping: { ...s.mapping, ...a.patch } }
    default:
      return s
  }
}

const INITIAL: State = {
  step: "upload",
  file: null,
  parseResult: null,
  mapping: EMPTY_MAPPING,
  loading: false,
  error: null,
}

const STEP_LABELS: Record<ImportStep, string> = {
  upload: "1. ファイル選択",
  preview: "2. 解析プレビュー",
  mapping: "3. 列マッピング",
  run: "4. Import 実行",
}

export default function ImportClient() {
  const router = useRouter()
  const [state, dispatch] = useReducer(reducer, INITIAL)

  const handleFile = async (file: File) => {
    dispatch({ type: "file_selected", file })
    dispatch({ type: "parse_start" })

    const formData = new FormData()
    formData.append("file", file)

    try {
      const res = await fetch("/api/import/parse", {
        method: "POST",
        body: formData,
      })
      const json = (await res.json()) as { data?: ParseResult; error?: { message?: string } }
      if (!res.ok) {
        dispatch({ type: "parse_error", message: json.error?.message ?? "解析に失敗しました" })
        return
      }
      dispatch({ type: "parse_ok", result: json.data! })
    } catch {
      dispatch({ type: "parse_error", message: "ネットワークエラーが発生しました" })
    }
  }

  const steps: ImportStep[] = ["upload", "preview", "mapping", "run"]
  const currentStepIndex = steps.indexOf(state.step)

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-50">
      {/* Header */}
      <header className="flex items-center gap-4 border-b border-zinc-200 bg-white px-5 py-3">
        <button onClick={() => router.push("/gallery")} className="text-sm text-zinc-500 hover:text-zinc-900">Gallery</button>
        <button onClick={() => router.push("/quick-add")} className="text-sm text-zinc-500 hover:text-zinc-900">Quick Add</button>
        <button onClick={() => router.push("/masters")} className="text-sm text-zinc-500 hover:text-zinc-900">Masters</button>
        <h1 className="text-base font-semibold text-zinc-900">Import</h1>
      </header>

      {/* Step indicator */}
      <div className="border-b border-zinc-200 bg-white px-6 py-3">
        <div className="flex items-center gap-2">
          {steps.slice(0, 3).map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              <div
                className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
                  i < currentStepIndex
                    ? "bg-green-100 text-green-700"
                    : i === currentStepIndex
                      ? "bg-blue-600 text-white"
                      : "bg-zinc-100 text-zinc-400"
                }`}
              >
                {i < currentStepIndex ? "✓" : i + 1}
              </div>
              <span className={`text-sm ${i === currentStepIndex ? "font-medium text-zinc-900" : "text-zinc-400"}`}>
                {STEP_LABELS[s]}
              </span>
              {i < 2 && <span className="text-zinc-300">›</span>}
            </div>
          ))}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-3xl">
          {/* CLI運用注意バナー */}
          <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <p className="font-semibold mb-1">このWeb画面は XLSX の解析プレビュー・列マッピング確認専用です</p>
            <ul className="list-disc list-inside space-y-0.5 text-amber-700">
              <li>画像ファイルの本格取り込みは <code className="font-mono bg-amber-100 px-1 rounded">npm run import:xlsx-batch</code>（ローカル CLI）で実行してください</li>
              <li>200 MB 級の XLSX ファイルはWebアップロードしないでください（解析専用・小容量のメタデータ確認用のみ）</li>
              <li>Google Drive 共有リンクからの直接インポートには対応していません</li>
            </ul>
          </div>

          {state.step === "upload" && (
            <div className="flex flex-col gap-4">
              <h2 className="text-base font-semibold text-zinc-900">ファイルを選択してください</h2>
              <FileDropzone
                onFile={(f) => void handleFile(f)}
                loading={state.loading}
                error={state.error}
              />
            </div>
          )}

          {state.step === "preview" && state.parseResult && (
            <div className="flex flex-col gap-4">
              <h2 className="text-base font-semibold text-zinc-900">解析結果</h2>
              <ParsePreview
                result={state.parseResult}
                onNext={() => dispatch({ type: "go_mapping" })}
                onBack={() => dispatch({ type: "go_back_upload" })}
              />
            </div>
          )}

          {state.step === "mapping" && state.parseResult && (
            <div className="flex flex-col gap-4">
              <h2 className="text-base font-semibold text-zinc-900">列マッピング</h2>
              <ColumnMapping_
                result={state.parseResult}
                mapping={state.mapping}
                onChange={(patch) => dispatch({ type: "patch_mapping", patch })}
                onBack={() => dispatch({ type: "go_back_parse" })}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
