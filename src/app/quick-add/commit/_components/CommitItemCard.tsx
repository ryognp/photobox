"use client"

import { useState } from "react";

type Props = {
  item: Record<string, unknown>;
  reasons?: string[];
  /** Phase 10-19A: undefined hides the delete button entirely (e.g. read-only contexts). */
  onDelete?: (itemId: string) => Promise<void>;
  /** commit中 / session確定後は削除不可 */
  deleteDisabled?: boolean;
};

type DeletePhase = "view" | "confirm" | "deleting" | "error";

type ItemSignedUrls = { thumbnail?: { signedUrl: string | null } } | null;

/** Private-bucket thumbnail. Renders the placeholder icon when no signed URL
 *  was resolved, or when the signed URL fails to load (expired / broken).
 *  Never receives a raw storage path — only a short-lived signed URL or null. */
function Thumbnail({ signedUrl, alt }: { signedUrl: string | null; alt: string }) {
  const [failed, setFailed] = useState(false);
  const showImage = signedUrl !== null && !failed;

  return (
    <div className="h-16 w-16 shrink-0 rounded-md bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-zinc-400 dark:text-zinc-600 text-xs select-none overflow-hidden">
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={signedUrl}
          alt={alt}
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-6 w-6"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v13.5a1.5 1.5 0 001.5 1.5z"
          />
        </svg>
      )}
    </div>
  );
}

type BadgeVariant = "green" | "zinc" | "blue" | "amber" | "red" | "zinc-strike";

function statusVariant(status: unknown): BadgeVariant {
  if (typeof status !== "string") return "zinc";
  const s = status.toUpperCase();
  if (["READY", "CLEAN", "FILLED", "COMMITTED"].includes(s)) return "green";
  if (["UPLOADING", "IN_PROGRESS"].includes(s)) return "blue";
  if (s === "DUPLICATE") return "amber";
  if (["ERROR", "FAILED"].includes(s)) return "red";
  if (s === "SKIPPED") return "zinc-strike";
  if (s === "DRAFT") return "blue";
  // PENDING, UNCHECKED, EMPTY, anything else
  return "zinc";
}

const badgeClasses: Record<BadgeVariant, string> = {
  green: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  zinc: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  blue: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  red: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400",
  "zinc-strike":
    "bg-zinc-100 text-zinc-400 line-through dark:bg-zinc-800 dark:text-zinc-500",
};

function StatusBadge({ label, status }: { label: string; status: unknown }) {
  if (status === undefined || status === null) return null;
  const variant = statusVariant(status);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium leading-none ${badgeClasses[variant]}`}
    >
      <span className="opacity-60">{label}</span>
      <span>{String(status)}</span>
    </span>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="flex gap-1 text-xs text-zinc-600 dark:text-zinc-400 min-w-0">
      <span className="shrink-0 font-medium text-zinc-400 dark:text-zinc-500">
        {label}
      </span>
      <span className="truncate">{value}</span>
    </div>
  );
}

export default function CommitItemCard({ item, reasons, onDelete, deleteDisabled }: Props) {
  const [deletePhase, setDeletePhase] = useState<DeletePhase>("view");
  const [deleteErrorMsg, setDeleteErrorMsg] = useState<string | null>(null);

  const itemId = item.id as string;
  const isCommitted = item.commitStatus === "COMMITTED";

  const handleDelete = async () => {
    if (!onDelete) return;
    setDeletePhase("deleting");
    setDeleteErrorMsg(null);
    try {
      await onDelete(itemId);
      // 成功時はこのカード自体が親のitems stateから消える想定なので、
      // ここでのphase復帰は不要(unmountされる)。
    } catch (e: unknown) {
      setDeleteErrorMsg((e as Error).message ?? "削除に失敗しました");
      setDeletePhase("error");
    }
  };

  const originalName = (item.originalName as string) ?? "Untitled";
  const rating = item.rating as number | null | undefined;
  const isFavorite = item.isFavorite as boolean | undefined;
  const notes = item.notes as string | null | undefined;
  const promptDraft = item.promptDraft as string | null | undefined;

  const scene = (item.scene as { name: string } | null)?.name ?? "";
  const tags =
    (item.tags as Array<{ tag: { name: string } }> | undefined)
      ?.map((t) => t.tag.name)
      .join(", ") ?? "";
  const persons =
    (item.persons as Array<{ person: { name: string } }> | undefined)
      ?.map((p) => p.person.name)
      .join(", ") ?? "";

  const truncatedNotes =
    notes && notes.length > 50 ? notes.slice(0, 50) + "…" : notes ?? "";
  const truncatedPrompt = promptDraft
    ? promptDraft.length > 80
      ? promptDraft.slice(0, 80) + "…"
      : promptDraft
    : "";

  const hasError = reasons && reasons.length > 0;
  const thumbnailSignedUrl =
    (item.signedUrls as ItemSignedUrls)?.thumbnail?.signedUrl ?? null;

  return (
    <div
      className={`flex gap-3 rounded-lg border bg-white p-3 shadow-sm dark:bg-zinc-900 ${
        hasError
          ? "border-red-300 dark:border-red-800"
          : "border-zinc-200 dark:border-zinc-700"
      }`}
    >
      <Thumbnail signedUrl={thumbnailSignedUrl} alt={originalName} />

      {/* Content */}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {/* Title row */}
        <div className="flex items-center gap-2 min-w-0">
          <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {originalName}
          </span>
          {isFavorite && (
            <span className="shrink-0 text-amber-400 text-sm leading-none">
              ★
            </span>
          )}
          {typeof rating === "number" && (
            <span className="shrink-0 text-xs text-zinc-400 dark:text-zinc-500">
              {"★".repeat(rating)}
              {"☆".repeat(Math.max(0, 5 - rating))}
            </span>
          )}
        </div>

        {/* Status badges */}
        <div className="flex flex-wrap gap-1">
          <StatusBadge label="upload" status={item.uploadStatus} />
          <StatusBadge label="prompt" status={item.promptStatus} />
          <StatusBadge label="dup" status={item.duplicateStatus} />
          <StatusBadge label="commit" status={item.commitStatus} />
        </div>

        {/* Meta rows */}
        <div className="flex flex-col gap-0.5">
          <MetaRow label="Scene" value={scene} />
          <MetaRow label="Tags" value={tags} />
          <MetaRow label="Persons" value={persons} />
          <MetaRow label="Notes" value={truncatedNotes} />
          {truncatedPrompt && (
            <div className="flex gap-1 text-xs text-zinc-500 dark:text-zinc-400 min-w-0">
              <span className="shrink-0 font-medium text-zinc-400 dark:text-zinc-500">
                Prompt
              </span>
              <span className="truncate italic">{truncatedPrompt}</span>
            </div>
          )}
        </div>

        {/* Reasons */}
        {hasError && (
          <ul className="mt-0.5 flex flex-col gap-0.5">
            {reasons!.map((r, i) => (
              <li
                key={i}
                className="text-xs text-red-600 dark:text-red-400 flex gap-1 items-start"
              >
                <span className="mt-px shrink-0">•</span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
        )}

        {/* Phase 10-19A: 個別削除。COMMITTED itemには表示しない。 */}
        {onDelete && !isCommitted && (
          <div className="mt-0.5">
            {deletePhase === "view" && (
              <button
                onClick={() => setDeletePhase("confirm")}
                disabled={deleteDisabled}
                className="text-xs text-red-500 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                削除
              </button>
            )}
            {deletePhase === "confirm" && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-red-600 dark:text-red-400">
                  この画像をプレビューから削除します。よろしいですか？
                </span>
                <button
                  onClick={() => void handleDelete()}
                  className="rounded bg-red-600 px-2 py-0.5 text-xs text-white hover:bg-red-700"
                >
                  削除する
                </button>
                <button
                  onClick={() => setDeletePhase("view")}
                  className="text-xs text-zinc-400 hover:text-zinc-700"
                >
                  キャンセル
                </button>
              </div>
            )}
            {deletePhase === "deleting" && (
              <span className="text-xs text-zinc-400">削除中...</span>
            )}
            {deletePhase === "error" && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-red-500">{deleteErrorMsg}</span>
                <button
                  onClick={() => setDeletePhase("view")}
                  className="text-xs text-zinc-400 hover:text-zinc-700"
                >
                  閉じる
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
