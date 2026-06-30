import "server-only";

export type CommitItemResult =
  | { kind: "committed"; uploadItemId: string; imageId: string }
  | { kind: "skipped"; uploadItemId: string; imageId: string }
  | { kind: "already_committed"; uploadItemId: string; imageId: string }
  | { kind: "failed"; uploadItemId: string; reason: string; message: string }
  | { kind: "invalid"; uploadItemId: string; reason: string; message: string };

export type CommitSummaryResult = {
  requested: number;
  committed: number;
  skipped: number;
  alreadyCommitted: number;
  failed: number;
  invalid: number;
};

export type CommitResponse = {
  summary: CommitSummaryResult;
  committed: Array<{ uploadItemId: string; imageId: string; status: "committed" }>;
  skipped: Array<{ uploadItemId: string; imageId: string; status: "skipped_duplicate" }>;
  alreadyCommitted: Array<{ uploadItemId: string; imageId: string; status: "already_committed" }>;
  failed: Array<{ uploadItemId: string; reason: string; message: string }>;
  invalid: Array<{ uploadItemId: string; reason: string; message: string }>;
  session: { id: string; status: string };
};
