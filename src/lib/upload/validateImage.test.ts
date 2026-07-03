import { describe, it, expect } from "vitest";
import { validateImageFile } from "@/lib/upload/validateImage";

// Magic-byte fixtures
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
// RIFF____WEBP
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, // RIFF
  0x00, 0x00, 0x00, 0x00, // size (any)
  0x57, 0x45, 0x42, 0x50, // WEBP
]);
// HEIC: ....ftypheic — not recognized by detectMimeFromBytes
const HEIC = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
  0x68, 0x65, 0x69, 0x63,
]);

function file(type: string, name = "upload"): File {
  // validateImageFile only reads file.type; bytes are passed separately.
  return new File([], name, { type });
}

describe("validateImageFile — valid images", () => {
  it("accepts JPEG with matching content-type", () => {
    expect(validateImageFile(file("image/jpeg"), JPEG)).toEqual({
      ok: true,
      mime: "image/jpeg",
      ext: "jpg",
    });
  });

  it("accepts PNG with matching content-type", () => {
    expect(validateImageFile(file("image/png"), PNG)).toEqual({
      ok: true,
      mime: "image/png",
      ext: "png",
    });
  });

  it("accepts WebP with matching content-type", () => {
    expect(validateImageFile(file("image/webp"), WEBP)).toEqual({
      ok: true,
      mime: "image/webp",
      ext: "webp",
    });
  });

  it("normalizes uppercase content-type", () => {
    expect(validateImageFile(file("IMAGE/JPEG"), JPEG)).toEqual({
      ok: true,
      mime: "image/jpeg",
      ext: "jpg",
    });
  });
});

describe("validateImageFile — MIME spoofing (content-type vs magic bytes)", () => {
  it("rejects PNG content-type with JPEG bytes as MIME_MISMATCH", () => {
    expect(validateImageFile(file("image/png"), JPEG)).toEqual({
      ok: false,
      reason: "MIME_MISMATCH",
    });
  });

  it("rejects JPEG content-type with PNG bytes as MIME_MISMATCH", () => {
    expect(validateImageFile(file("image/jpeg"), PNG)).toEqual({
      ok: false,
      reason: "MIME_MISMATCH",
    });
  });
});

describe("validateImageFile — filename extension is NOT used", () => {
  it("accepts based on content-type+bytes regardless of filename (fixes current spec)", () => {
    // Named .png but truly a JPEG (content-type jpeg + jpeg bytes) → accepted.
    expect(validateImageFile(file("image/jpeg", "photo.png"), JPEG)).toEqual({
      ok: true,
      mime: "image/jpeg",
      ext: "jpg",
    });
  });
});

describe("validateImageFile — unsupported content-type", () => {
  it("rejects HEIC content-type at the content-type gate", () => {
    expect(validateImageFile(file("image/heic"), HEIC)).toEqual({
      ok: false,
      reason: "UNSUPPORTED_MEDIA_TYPE",
    });
  });

  it("rejects GIF content-type", () => {
    expect(validateImageFile(file("image/gif"), JPEG)).toEqual({
      ok: false,
      reason: "UNSUPPORTED_MEDIA_TYPE",
    });
  });

  it("rejects empty content-type", () => {
    expect(validateImageFile(file(""), JPEG)).toEqual({
      ok: false,
      reason: "UNSUPPORTED_MEDIA_TYPE",
    });
  });
});

describe("validateImageFile — unrecognized / degenerate bytes", () => {
  it("rejects allowed content-type with HEIC bytes as UNSUPPORTED_MEDIA_TYPE", () => {
    // content-type passes the gate, but magic bytes are unrecognized.
    expect(validateImageFile(file("image/jpeg"), HEIC)).toEqual({
      ok: false,
      reason: "UNSUPPORTED_MEDIA_TYPE",
    });
  });

  it("rejects empty file (0 bytes)", () => {
    expect(validateImageFile(file("image/png"), new Uint8Array([]))).toEqual({
      ok: false,
      reason: "UNSUPPORTED_MEDIA_TYPE",
    });
  });

  it("rejects extremely short file (2 bytes)", () => {
    expect(validateImageFile(file("image/jpeg"), new Uint8Array([0xff, 0xd8]))).toEqual({
      ok: false,
      reason: "UNSUPPORTED_MEDIA_TYPE",
    });
  });

  it("does not misdetect a truncated WebP header (RIFF only, no WEBP)", () => {
    const riffOnly = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00]);
    expect(validateImageFile(file("image/webp"), riffOnly)).toEqual({
      ok: false,
      reason: "UNSUPPORTED_MEDIA_TYPE",
    });
  });
});
