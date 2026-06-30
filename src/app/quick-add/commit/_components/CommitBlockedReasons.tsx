"use client"

import { CommitBlockReason } from "@/lib/quick-add/commitReadiness"

type Props = {
  reasons: CommitBlockReason[]
  canCommit: boolean
}

export function CommitBlockedReasons({ reasons, canCommit }: Props) {
  if (canCommit) {
    return (
      <div className="flex items-center gap-2 rounded-md bg-green-50 px-4 py-3 text-green-700 border border-green-200">
        <span className="text-green-500">✓</span>
        <span className="text-sm font-medium">保存可能です</span>
      </div>
    )
  }

  if (reasons.length === 0) {
    return null
  }

  return (
    <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3">
      <p className="mb-2 text-sm font-semibold text-red-700">保存できない理由</p>
      <ul className="space-y-1">
        {reasons.map((reason, index) => (
          <li key={`${reason.code}-${index}`} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5 text-amber-500">⚠</span>
            <span className="font-mono text-xs text-red-500 shrink-0">[{reason.code}]</span>
            <span className="text-red-700">{reason.message}</span>
            {reason.count !== undefined && reason.count > 0 && (
              <span className="ml-auto shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-600">
                {reason.count}件
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
