"use client"

import type { CommitSummary } from "@/lib/quick-add/commitReadiness"

type Props = {
  summary: CommitSummary
  sessionId: string
}

type StatCellProps = {
  label: string
  value: number
  highlight?: "good" | "warn" | "none"
}

function StatCell({ label, value, highlight = "none" }: StatCellProps) {
  const valueClass =
    highlight === "good"
      ? "text-green-600 dark:text-green-400"
      : highlight === "warn" && value > 0
        ? "text-amber-600 dark:text-amber-400"
        : "text-foreground"

  return (
    <div className="flex flex-col items-center gap-0.5 px-3 py-2">
      <span className={`text-2xl font-semibold tabular-nums leading-none ${valueClass}`}>
        {value}
      </span>
      <span className="text-xs text-muted-foreground whitespace-nowrap">{label}</span>
    </div>
  )
}

export function CommitSummary({ summary }: Props) {
  return (
    <div className="rounded-lg border bg-card text-card-foreground shadow-sm">
      <div className="flex flex-wrap justify-center divide-x divide-border">
        <StatCell label="Total" value={summary.total} />
        <StatCell label="Ready" value={summary.ready} highlight="none" />
        <StatCell
          label="Not ready"
          value={summary.total - summary.ready - summary.errors}
          highlight="warn"
        />
        <StatCell label="Prompt filled" value={summary.filled} />
        <StatCell label="Missing prompt" value={summary.missingPrompt} highlight="warn" />
        <StatCell label="Duplicate" value={summary.duplicate} highlight="warn" />
        <StatCell label="Skipped" value={summary.skipped} />
        <StatCell label="Committable" value={summary.committable} highlight="good" />
      </div>
    </div>
  )
}
