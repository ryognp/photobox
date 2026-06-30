import { SupabaseClient } from "@supabase/supabase-js";

export async function uploadBuffer(
  supabase: SupabaseClient,
  bucket: string,
  storagePath: string,
  buffer: Buffer,
  contentType: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { error } = await supabase.storage
    .from(bucket)
    .upload(storagePath, buffer, { contentType, upsert: true });

  if (error) {
    return { ok: false, message: error.message };
  }
  return { ok: true };
}
