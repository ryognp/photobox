import "server-only";

import { supabaseAdmin } from "@/lib/supabase/admin";

const BUCKET = "photobox-private";

export type CopyResult =
  | { ok: true }
  | { ok: false; message: string };

export async function copyStorageFile(
  fromPath: string,
  toPath: string,
): Promise<CopyResult> {
  // Try copy; if the destination exists Supabase returns an error — delete and retry
  const { error: copyError } = await supabaseAdmin.storage
    .from(BUCKET)
    .copy(fromPath, toPath);

  if (!copyError) return { ok: true };

  // "already exists" — delete destination and retry
  if (
    copyError.message?.toLowerCase().includes("already exist") ||
    copyError.message?.toLowerCase().includes("duplicate") ||
    copyError.statusCode === "409" ||
    (copyError as unknown as Record<string, unknown>).statusCode === 409
  ) {
    await supabaseAdmin.storage.from(BUCKET).remove([toPath]);
    const { error: retryError } = await supabaseAdmin.storage
      .from(BUCKET)
      .copy(fromPath, toPath);
    if (!retryError) return { ok: true };
    return { ok: false, message: retryError.message ?? "Storage copy failed after retry" };
  }

  return { ok: false, message: copyError.message ?? "Storage copy failed" };
}

export async function deleteStorageFile(path: string): Promise<void> {
  await supabaseAdmin.storage.from(BUCKET).remove([path]);
}
