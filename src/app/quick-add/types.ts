import type { SignedUrls } from "@/lib/upload/uploadClient";

export type LocalItemStatus = "queued" | "hashing" | "compressing" | "uploading" | "done" | "error";

export type LocalItem = {
  clientId: string;
  file: File | null;
  status: LocalItemStatus;
  error: string | null;
  previewObjectUrl: string | null;
  serverId: string | null;
  serverItem: Record<string, unknown> | null;
  signedUrls: SignedUrls | null;
};
