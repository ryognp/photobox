import "server-only";

export type AllowedMime = "image/jpeg" | "image/png" | "image/webp";
export type ImageExt = "jpg" | "png" | "webp";

const MIME_TO_EXT: Record<AllowedMime, ImageExt> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const ALLOWED_MIMES = new Set<string>(Object.keys(MIME_TO_EXT));

// magic bytes で MIME を判定
function detectMimeFromBytes(buf: Uint8Array): AllowedMime | null {
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return "image/png";

  // WebP: RIFF .... WEBP
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return "image/webp";

  return null;
}

export type ImageValidation =
  | { ok: true; mime: AllowedMime; ext: ImageExt }
  | { ok: false; reason: "UNSUPPORTED_MEDIA_TYPE" | "MIME_MISMATCH" };

export function validateImageFile(file: File, bytes: Uint8Array): ImageValidation {
  const contentType = file.type.toLowerCase();

  // Content-Type が許可外
  if (!ALLOWED_MIMES.has(contentType)) {
    return { ok: false, reason: "UNSUPPORTED_MEDIA_TYPE" };
  }

  // magic bytes で実際の MIME を確認
  const detectedMime = detectMimeFromBytes(bytes);
  if (!detectedMime) {
    return { ok: false, reason: "UNSUPPORTED_MEDIA_TYPE" };
  }

  // Content-Type と magic bytes が矛盾する場合は拒否
  if (detectedMime !== contentType) {
    return { ok: false, reason: "MIME_MISMATCH" };
  }

  return { ok: true, mime: detectedMime, ext: MIME_TO_EXT[detectedMime] };
}
