import { sha256Hex } from "./hashClient";
import { getImageDimensions, generateWebpBlob } from "./thumbnailClient";

export type UploadStage = "hashing" | "compressing" | "uploading" | "done" | "error";

export type UploadProgress = {
  stage: UploadStage;
  error?: string;
};

export type SignedUrls = {
  thumbnail: { signedUrl: string | null; fallback: string | null };
  preview: { signedUrl: string | null; fallback: string | null };
  original: { signedUrl: string | null; fallback: string | null };
};

export type UploadResult = {
  item: Record<string, unknown>;
  signedUrls: SignedUrls;
};

export async function uploadFile(
  file: File,
  sessionId: string,
  onProgress: (p: UploadProgress) => void,
): Promise<UploadResult> {
  onProgress({ stage: "hashing" });
  const hash = await sha256Hex(file);

  onProgress({ stage: "compressing" });
  const dims = await getImageDimensions(file);
  const thumbBlob = await generateWebpBlob(file, 300, 0.85);
  const previewBlob = await generateWebpBlob(file, 800, 0.9);

  onProgress({ stage: "uploading" });
  const formData = new FormData();
  formData.append("sessionId", sessionId);
  formData.append("clientFileHash", hash);
  formData.append("original", file, file.name);
  formData.append("originalName", file.name);
  if (dims) {
    formData.append("widthPx", String(dims.w));
    formData.append("heightPx", String(dims.h));
  }
  if (thumbBlob) {
    formData.append("thumbnail", thumbBlob, "thumbnail.webp");
  }
  if (previewBlob) {
    formData.append("preview", previewBlob, "preview.webp");
  }

  const response = await fetch("/api/uploads/items", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    let msg = `Upload failed: ${response.status}`;
    try {
      const errJson = await response.json() as { error?: { message?: string } | string; message?: string };
      const e = errJson.error;
      msg = (typeof e === "object" ? e?.message : e) ?? errJson.message ?? msg;
    } catch { /* ignore */ }
    throw new Error(msg);
  }

  const json = await response.json() as { data: { item: Record<string, unknown>; signedUrls: SignedUrls } };
  const { item, signedUrls } = json.data;

  onProgress({ stage: "done" });
  return { item, signedUrls };
}
